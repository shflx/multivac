import assert from 'node:assert/strict';
import test from 'node:test';
import type { VisibleAssistantMessage } from '../src/features/assistant/streaming-messages.js';
import {
  groupAssistantTimeline,
  interleaveRunTraceNotes,
  mergeAssistantTimeline,
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

const trace: RunTrace = {
  commandId: 'command-1', cursor: '20', status: 'succeeded', thinkingTruncated: false,
  startedAt: '2026-09-27T08:00:00.000Z', endedAt: '2026-09-27T08:00:09.000Z',
  entries: [
    { kind: 'thinking', cursor: '11', text: '先看约束。', truncated: false },
    { kind: 'message', cursor: '12', messageId: 'assistant:1' },
    { kind: 'tool', cursor: '13', toolCallId: 'tool-read' },
    { kind: 'message', cursor: '15', messageId: 'assistant:2' },
    { kind: 'tool', cursor: '16', toolCallId: 'tool-test' },
    { kind: 'message', cursor: '18', messageId: 'assistant:3' },
  ],
};

// Pi 历史：用户消息 → 过程正文 → 过程正文 → 最终回复；工具时间与正文相同毫秒也不影响位置。
const history = [
  message('user-1', 'user', '读约束后跑测试', '2026-09-27T08:00:00.000Z'),
  message('note-1', 'assistant', '我先读一下项目约束。', '2026-09-27T08:00:01.000Z', { runtimeMessageId: 'assistant:1' }),
  message('note-2', 'assistant', '约束已确认，再跑一下测试。', '2026-09-27T08:00:01.000Z', { runtimeMessageId: 'assistant:2' }),
  message('reply', 'assistant', '测试全部通过。', '2026-09-27T08:00:01.000Z', { runtimeMessageId: 'assistant:3' }),
];
const tools = [tool('tool-read', '2026-09-27T08:00:01.000Z', '13'), tool('tool-test', '2026-09-27T08:00:01.000Z', '16')];

test('一轮里调用过工具之前的正文收进同一个轨迹，只留最终回复', () => {
  const grouped = groupAssistantTimeline(
    mergeAssistantTimeline(history, tools, [{ commandId: 'command-1', piEntryId: 'reply' }]),
    [trace],
  );
  assert.deepEqual(grouped.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace', 'reply']);
  const merged = grouped[1];
  assert.ok(merged?.kind === 'trace');
  assert.equal(merged.key, 'run:command-1');
  assert.equal(merged.replyFollows, true);
  assert.deepEqual(merged.tools.map((item) => item.toolCallId), ['tool-read', 'tool-test']);
  assert.deepEqual(merged.notes?.map((note) => note.id), ['note-1', 'note-2']);
});

test('运行中：正在输出的正文先作为回复，其后一旦调用工具就收进轨迹', () => {
  const streaming = [
    history[0]!,
    message('stream-1', 'assistant', '我先读一下项目约束。', '2026-09-27T08:00:01.000Z',
      { runtimeMessageId: 'assistant:1', commandId: 'command-1', streamCursor: 12 }),
  ];
  const before = groupAssistantTimeline(mergeAssistantTimeline(streaming, []), []);
  assert.deepEqual(before.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'stream-1']);

  const after = groupAssistantTimeline(mergeAssistantTimeline(streaming, [tools[0]!], [], new Set(['command-1'])), []);
  assert.deepEqual(after.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace']);
  assert.ok(after[1]?.kind === 'trace' && after[1].replyFollows === false);
});

test('没有工具时连续的助手正文仍各自是回复；失败且没有最终回复时正文都在轨迹里', () => {
  const plain = groupAssistantTimeline(mergeAssistantTimeline([
    history[0]!, message('a', 'assistant', '第一段', '2026-09-27T08:00:01.000Z'),
    message('b', 'assistant', '第二段', '2026-09-27T08:00:02.000Z'),
  ], []), []);
  assert.deepEqual(plain.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'a', 'b']);

  const failed = groupAssistantTimeline(mergeAssistantTimeline(history.slice(0, 2), [tools[0]!],
    [{ commandId: 'command-1', piEntryId: 'note-1' }]), []);
  // 锚点落在唯一的正文上时工具排在它之前；该正文之后没有工具，仍是回复。
  assert.deepEqual(failed.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace', 'note-1']);

  const interrupted = groupAssistantTimeline(mergeAssistantTimeline(history.slice(0, 2),
    [tool('tool-read', '2026-09-27T08:00:02.000Z', '13')], [], new Set(['command-1'])), []);
  assert.deepEqual(interrupted.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace']);
});

test('过程说明按正文开始位置放回思考与工具之间，最终回复的位置标记不展示', () => {
  const entries = interleaveRunTraceNotes(trace.entries, history.slice(1, 3), tools);
  assert.deepEqual(entries.map((entry) => entry.kind === 'note' ? `note:${entry.message.id}`
    : entry.kind === 'tool' ? `tool:${entry.toolCallId}` : entry.kind), [
    'thinking', 'note:note-1', 'tool:tool-read', 'note:note-2', 'tool:tool-test',
  ]);
});

test('没有位置记录的过程说明按时间排在其后开始的第一个工具之前', () => {
  const entries = interleaveRunTraceNotes(
    trace.entries.filter((entry) => entry.kind !== 'message'),
    [message('n1', 'assistant', '一', '2026-09-27T08:00:01.000Z'), message('n2', 'assistant', '二', '2026-09-27T08:00:03.000Z')],
    [tool('tool-read', '2026-09-27T08:00:02.000Z', '13'), tool('tool-test', '2026-09-27T08:00:04.000Z', '16')],
  );
  assert.deepEqual(entries.map((entry) => entry.kind === 'note' ? `note:${entry.message.id}`
    : entry.kind === 'tool' ? `tool:${entry.toolCallId}` : entry.kind), [
    'thinking', 'note:n1', 'tool:tool-read', 'note:n2', 'tool:tool-test',
  ]);
});
