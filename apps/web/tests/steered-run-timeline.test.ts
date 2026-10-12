import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisibleAssistantMessage } from '../src/features/assistant/streaming-messages.js';
import {
  applyRunTraceEvent,
  buildAssistantTimeline,
  groupAssistantTimeline,
  mergeAssistantTimeline,
  renderableRunTraceEntries,
  type AssistantGroupedTimelineItem,
  type RunTrace,
  type ToolExecution,
} from '../src/features/assistant/tool-executions.js';

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: string,
  extra: Partial<VisibleAssistantMessage> = {}): VisibleAssistantMessage {
  return { id, piSessionId: 'pi', piEntryId: id, role, text, createdAt, ...extra };
}

function tool(toolCallId: string, startedAt: string, cursor: string, status: ToolExecution['status'] = 'succeeded'): ToolExecution {
  return {
    toolCallId, toolName: 'read', displayName: '读取文件', commandId: 'command-1', cursor, status,
    summary: '读取文件', detail: `读取 ${toolCallId}`, isError: false, startedAt, endedAt: status === 'running' ? null : startedAt,
    detailState: 'absent', authorization: null,
  };
}

function shape(items: readonly AssistantGroupedTimelineItem[]): string[] {
  return items.map((item) => item.kind === 'trace'
    ? `trace:${item.tools.map((record) => record.toolCallId).join(',')}`
    : item.message.id);
}

// 发起本轮的消息 → 过程正文与第一个工具 → 交付的调整消息 → 第二个工具 → 最终回复。
const history = [
  message('user-1', 'user', '先检查第一项', '2026-10-12T08:00:00.000Z', { runtimeMessageId: 'user:1' }),
  message('note-1', 'assistant', '我先读第一项。', '2026-10-12T08:00:01.000Z', { runtimeMessageId: 'assistant:1' }),
  message('user-2', 'user', '改为检查第二项', '2026-10-12T08:00:03.000Z', { runtimeMessageId: 'user:2' }),
  message('reply', 'assistant', '第二项没有问题。', '2026-10-12T08:00:05.000Z', { runtimeMessageId: 'assistant:2' }),
];
const trace: RunTrace = {
  commandId: 'command-1', cursor: '30', status: 'succeeded', thinkingTruncated: false,
  startedAt: '2026-10-12T08:00:00.000Z', endedAt: '2026-10-12T08:00:06.000Z',
  entries: [
    { kind: 'user', cursor: '10', messageId: 'user:1' },
    { kind: 'thinking', cursor: '11', text: '先看第一项。', truncated: false },
    { kind: 'message', cursor: '12', messageId: 'assistant:1' },
    { kind: 'tool', cursor: '13', toolCallId: 'tool-first' },
    { kind: 'user', cursor: '20', messageId: 'user:2' },
    { kind: 'thinking', cursor: '21', text: '改看第二项。', truncated: false },
    { kind: 'tool', cursor: '22', toolCallId: 'tool-second' },
    { kind: 'message', cursor: '25', messageId: 'assistant:2' },
  ],
};
const tools = [
  tool('tool-first', '2026-10-12T08:00:02.000Z', '15'),
  tool('tool-second', '2026-10-12T08:00:04.000Z', '24'),
];

test('交付的调整消息把运行切成两段：各段跟在所属消息之下，命令身份不变', () => {
  // 结束后的锚点是最终回复；调整前的工具不能因此排到调整消息之后。
  const timeline = buildAssistantTimeline(history, tools, [{ commandId: 'command-1', piEntryId: 'reply' }], [trace]);
  assert.deepEqual(shape(timeline), ['user-1', 'trace:tool-first', 'user-2', 'trace:tool-second', 'reply']);

  const [first, second] = timeline.filter((item) => item.kind === 'trace');
  assert.ok(first?.kind === 'trace' && second?.kind === 'trace');
  assert.notEqual(first.key, second.key);
  assert.equal(first.commandId, 'command-1');
  assert.equal(second.commandId, 'command-1');
  assert.equal(first.trace?.commandId, 'command-1');
  assert.equal(first.tools[0], tools[0]);

  // 让位的一段在调整消息交付时结束，只保留自己的思考与过程正文。
  assert.equal(first.superseded, true);
  assert.equal(first.trace?.status, 'succeeded');
  assert.equal(first.trace?.endedAt, '2026-10-12T08:00:03.000Z');
  assert.deepEqual(first.notes?.map((note) => note.id), ['note-1']);
  assert.deepEqual(renderableRunTraceEntries(first.trace, first.tools).map((entry) => entry.cursor), ['11', '12', '13']);
  assert.equal(second.superseded, undefined);
  assert.equal(second.trace?.startedAt, '2026-10-12T08:00:03.000Z');
  assert.equal(second.trace?.endedAt, '2026-10-12T08:00:06.000Z');
  assert.deepEqual(renderableRunTraceEntries(second.trace, second.tools).map((entry) => entry.cursor), ['21', '22', '25']);
});

test('运行中：调整后的在途工具与正文排在调整消息之下，只有最后一段仍在运行', () => {
  const running: RunTrace = { ...trace, status: 'running', endedAt: null, entries: trace.entries.slice(0, 7) };
  const streaming = message('stream-2', 'assistant', '正在看第二项', '2026-10-12T08:00:04.500Z',
    { runtimeMessageId: 'assistant:2', commandId: 'command-1', streamCursor: 26 });
  const timeline = buildAssistantTimeline([...history.slice(0, 3), streaming],
    [tools[0]!, tool('tool-second', '2026-10-12T08:00:04.000Z', '22', 'running')],
    [{ commandId: 'command-1', piEntryId: 'user-1' }], [{ ...running, entries: [...running.entries,
      { kind: 'message', cursor: '23', messageId: 'assistant:2' }] }]);
  assert.deepEqual(shape(timeline), ['user-1', 'trace:tool-first', 'user-2', 'trace:tool-second', 'stream-2']);
  const [first, second] = timeline.filter((item) => item.kind === 'trace');
  assert.ok(first?.kind === 'trace' && second?.kind === 'trace');
  assert.equal(first.trace?.status, 'succeeded');
  assert.equal(second.trace?.status, 'running');
  const reply = timeline.at(-1);
  assert.ok(reply?.kind === 'message');
  assert.equal(reply.message, streaming);
});

test('调整消息尚未交付（只有本地回显）或旧轨迹没有用户消息位置时，时间线保持原样', () => {
  const pending = [history[0]!, history[1]!, message('pending:steer', 'user', '改为检查第二项', '2026-10-12T08:00:03.000Z',
    { commandId: 'command-2', streamCursor: Number.MAX_SAFE_INTEGER })];
  const running: RunTrace = { ...trace, status: 'running', endedAt: null, entries: trace.entries.slice(0, 4) };
  const anchors = [{ commandId: 'command-1', piEntryId: 'user-1' }];
  const expected = groupAssistantTimeline(
    mergeAssistantTimeline(pending, [tools[0]!], anchors, new Set(['command-1']), [running]), [running], anchors);
  assert.deepEqual(buildAssistantTimeline(pending, [tools[0]!], anchors, [running]), expected);

  const legacy: RunTrace = { ...trace, entries: trace.entries.filter((entry) => entry.kind !== 'user') };
  // 同一命令的多条锚点原样保留：窗口外的锚点不能覆盖窗口内的锚点。
  const legacyAnchors = [{ commandId: 'command-1', piEntryId: 'reply' }, { commandId: 'command-1', piEntryId: 'outside' }];
  assert.deepEqual(buildAssistantTimeline(history, tools, legacyAnchors, [legacy]),
    groupAssistantTimeline(mergeAssistantTimeline(history, tools, legacyAnchors, new Set(), [legacy]), [legacy], legacyAnchors));
});

test('用户消息事件只给运行中的轨迹记录一次交付位置', () => {
  const base = { eventId: 'event', assistantSessionId: 'global-coordinator', commandId: 'command-1', occurredAt: '2026-10-12T08:00:03.000Z' };
  let traces: RunTrace[] = [{ ...trace, status: 'running', cursor: '13', endedAt: null, entries: trace.entries.slice(0, 4) }];
  traces = applyRunTraceEvent(traces, { ...base, cursor: '20', type: 'assistant.message.changed', data: { messageId: 'user:2', role: 'user' } });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '21', type: 'assistant.message.changed', data: { messageId: 'user:2', role: 'user' } });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '22', type: 'assistant.message.changed', data: { messageId: 'assistant:2', role: 'assistant' } });
  assert.deepEqual(traces[0]?.entries.filter((entry) => entry.kind === 'user'), [
    { kind: 'user', cursor: '10', messageId: 'user:1' },
    { kind: 'user', cursor: '20', messageId: 'user:2' },
  ]);
  assert.equal(traces[0]?.cursor, '21');

  const settled = applyRunTraceEvent([{ ...traces[0]!, status: 'succeeded' }],
    { ...base, cursor: '30', type: 'assistant.message.changed', data: { messageId: 'user:3', role: 'user' } });
  assert.equal(settled[0]?.entries.some((entry) => entry.kind === 'user' && entry.messageId === 'user:3'), false);
});
