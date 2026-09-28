import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisibleAssistantMessage } from '../src/features/assistant/streaming-messages.js';
import {
  applyRunTraceEvent,
  groupAssistantTimeline,
  interleaveRunTraceNotes,
  mergeAssistantTimeline,
  renderableRunTraceEntries,
  type RunTrace,
  type ToolExecution,
} from '../src/features/assistant/tool-executions.js';

function message(id: string, role: 'user' | 'assistant', text: string, createdAt: string,
  extra: Partial<VisibleAssistantMessage> = {}): VisibleAssistantMessage {
  return { id, piSessionId: 'pi', piEntryId: id, role, text, createdAt, ...extra };
}

function tool(toolCallId: string, startedAt: string, cursor: string, commandId = 'command-1'): ToolExecution {
  return {
    toolCallId, toolName: 'read', displayName: '读取文件', commandId, cursor, status: 'succeeded',
    summary: '读取文件完成', detail: `读取 ${toolCallId}`, isError: false, startedAt, endedAt: startedAt,
    detailState: 'absent', authorization: null,
  };
}

function trace(commandId: string, entries: RunTrace['entries']): RunTrace {
  return {
    commandId, cursor: '20', status: 'failed', thinkingTruncated: false, entries,
    startedAt: '2026-09-27T08:00:00.000Z', endedAt: '2026-09-27T08:00:09.000Z',
  };
}

const kinds = (items: ReturnType<typeof groupAssistantTimeline>) =>
  items.map((item) => item.kind === 'trace' ? 'trace' : item.message.id);

const messages = [
  message('u1', 'user', '第一问', '2026-09-27T08:00:00.000Z'),
  message('r1', 'assistant', '第一答', '2026-09-27T08:00:02.000Z'),
  message('u2', 'user', '第二问', '2026-09-27T08:00:03.000Z'),
];

test('运行中命令的工具记录属于最新一轮，与流式正文按事件水位比较', () => {
  const streaming = [...messages,
    message('s1', 'assistant', '正在读', '2026-09-27T08:00:05.000Z', { commandId: 'command-1', streamCursor: 12 })];
  // 工具时间早于上一轮回复（时钟偏差），但命令仍在运行：排在最后一条用户消息之后。
  const before = mergeAssistantTimeline(streaming, [tool('tool-a', '2026-09-27T08:00:01.000Z', '11')], [], new Set(['command-1']));
  assert.deepEqual(before.map((item) => item.kind === 'tool' ? 'tool' : item.message.id), ['u1', 'r1', 'u2', 'tool', 's1']);
  // 同一毫秒内开始的工具按水位排在已输出的正文之后。
  const after = mergeAssistantTimeline(streaming, [tool('tool-b', '2026-09-27T08:00:05.000Z', '13')], [], new Set(['command-1']));
  assert.deepEqual(after.map((item) => item.kind === 'tool' ? 'tool' : item.message.id), ['u1', 'r1', 'u2', 's1', 'tool']);
});

test('已结束但没有锚点的旧命令工具按时间放回原处，不会并入最新一轮', () => {
  const stale = tool('tool-old', '2026-09-27T08:00:01.000Z', '5', 'command-old');
  assert.deepEqual(kinds(groupAssistantTimeline(mergeAssistantTimeline(messages, [stale]), [])), ['u1', 'trace', 'r1', 'u2']);
});

test('没有回复就失败的命令锚在自己的用户消息上：轨迹留在这一轮', () => {
  const anchors = [{ commandId: 'command-failed', piEntryId: 'u2' }];
  const failedTool = tool('tool-failed', '2026-09-27T08:00:04.000Z', '9', 'command-failed');
  assert.deepEqual(kinds(groupAssistantTimeline(
    mergeAssistantTimeline(messages, [failedTool], anchors),
    [trace('command-failed', [{ kind: 'tool', cursor: '9', toolCallId: 'tool-failed' }])],
    anchors,
  )), ['u1', 'r1', 'u2', 'trace']);
  assert.deepEqual(kinds(groupAssistantTimeline(mergeAssistantTimeline(messages, []),
    [trace('command-failed', [{ kind: 'thinking', cursor: '9', text: '想了想', truncated: false }])],
    anchors)), ['u1', 'r1', 'u2', 'trace']);
});

test('本地回显带命令身份：同命令的轨迹排在回显之后，不会被当成回复前移', () => {
  const echo = message('pending:command-1', 'user', '第三问', '2026-09-27T08:00:05.000Z',
    { commandId: 'command-1', streamCursor: Number.MAX_SAFE_INTEGER });
  const running = { ...trace('command-1', [{ kind: 'thinking', cursor: '21', text: '想想', truncated: false }]), status: 'running' as const };
  assert.deepEqual(kinds(groupAssistantTimeline(mergeAssistantTimeline([...messages, echo], []), [running])),
    ['u1', 'r1', 'u2', 'pending:command-1', 'trace']);
});

test('实时事件记录每条正文开始输出的位置，只记一次，渲染条目不含位置标记', () => {
  const delta = (cursor: string, messageId: string) => ({
    cursor, eventId: `event:${cursor}`, assistantSessionId: 'global-coordinator', commandId: 'command-1',
    occurredAt: '2026-09-27T08:00:00.000Z', type: 'assistant.message.delta' as const,
    data: { piSessionId: 'pi', messageId, delta: '文字' },
  });
  let traces = applyRunTraceEvent([], delta('1', 'assistant:1'));
  traces = applyRunTraceEvent(traces, delta('2', 'assistant:1'));
  traces = applyRunTraceEvent(traces, delta('3', 'assistant:2'));
  assert.equal(traces[0]?.status, 'running');
  assert.deepEqual(traces[0]?.entries, [
    { kind: 'message', cursor: '1', messageId: 'assistant:1' },
    { kind: 'message', cursor: '3', messageId: 'assistant:2' },
  ]);
  // 位置标记用于放回过程说明；没有对应过程说明的标记（如最终回复）不展示。
  assert.deepEqual(interleaveRunTraceNotes(renderableRunTraceEntries(traces[0], []), [], []), []);
});
