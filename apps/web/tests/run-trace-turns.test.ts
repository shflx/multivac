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

test('没有最终回复的命令恢复历史时，锚点正文按事件顺序收进轨迹', () => {
  for (const status of ['running', 'failed', 'cancelled'] as const) {
    const grouped = groupAssistantTimeline(
      mergeAssistantTimeline(history.slice(0, 3), tools, [{ commandId: 'command-1', piEntryId: 'note-2' }]),
      [{ ...trace, status, entries: trace.entries.slice(0, -1) }],
    );
    assert.deepEqual(grouped.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace']);
    const merged = grouped[1];
    assert.ok(merged?.kind === 'trace');
    assert.equal(merged.replyFollows, false);
    assert.deepEqual(merged.notes?.map((note) => note.id), ['note-1', 'note-2']);
  }
});

test('工具记录的状态水位晚于最终回复时，按轨迹的工具开始水位保留回复', () => {
  const updatedTools = tools.map((record) => ({ ...record, cursor: '30' }));
  const grouped = groupAssistantTimeline(
    mergeAssistantTimeline(history, updatedTools, [{ commandId: 'command-1', piEntryId: 'reply' }]),
    [trace],
  );
  assert.deepEqual(grouped.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace', 'reply']);
});

test('取消后的命令没有锚点且时钟早于用户消息时，仍按正文身份定位轨迹', () => {
  const cancelled = { ...trace, status: 'cancelled' as const, entries: trace.entries.slice(0, -1) };
  const earlyTools = tools.map((record) => ({ ...record, startedAt: '2026-09-27T07:00:00.000Z' }));
  const grouped = groupAssistantTimeline(
    mergeAssistantTimeline(history.slice(0, 3), earlyTools, [], new Set(), [cancelled]), [cancelled],
  );
  assert.deepEqual(grouped.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace']);
  assert.ok(grouped[1]?.kind === 'trace');
  assert.deepEqual(grouped[1].notes?.map((note) => note.id), ['note-1', 'note-2']);
});

test('正文位置水位明确晚于工具时，列表重排仍保留真正的回复', () => {
  const grouped = groupAssistantTimeline([
    { kind: 'message', key: 'user', message: history[0]! },
    { kind: 'message', key: 'reply', message: history[3]! },
    ...tools.map((tool) => ({ kind: 'tool' as const, key: tool.toolCallId, tool })),
  ], [trace]);
  assert.deepEqual(grouped.map((item) => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'reply', 'trace']);
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

test('历史分页从助手过程正文开始时，仍按轨迹身份收起过程说明', () => {
  const grouped = groupAssistantTimeline(
    mergeAssistantTimeline(history.slice(1), tools, [{ commandId: 'command-1', piEntryId: 'reply' }]),
    [trace],
  );
  assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['trace', 'reply']);
  assert.ok(grouped[0]?.kind === 'trace');
  assert.deepEqual(grouped[0].notes?.map(note => note.id), ['note-1', 'note-2']);
});

test('工具摘要已离开快照窗口时，保留的轨迹位置仍能区分过程与最终回复', () => {
  const anchors = [{ commandId: 'command-1', piEntryId: 'reply' }];
  const grouped = groupAssistantTimeline(mergeAssistantTimeline(history, [], anchors), [trace], anchors);
  assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace', 'reply']);
  assert.ok(grouped[1]?.kind === 'trace');
  assert.deepEqual(grouped[1].notes?.map(note => note.id), ['note-1', 'note-2']);
});

test('分页缺少用户消息且正文无轨迹身份时，不把普通回复误收为过程说明', () => {
  const unknown = message('unknown', 'assistant', '没有归属记录的回复', '2026-09-27T07:00:00.000Z');
  const grouped = groupAssistantTimeline(
    mergeAssistantTimeline([unknown, ...history.slice(1)], tools, [{ commandId: 'command-1', piEntryId: 'reply' }]), [trace],
  );
  assert.ok(grouped.some(item => item.kind === 'message' && item.message.id === 'unknown'));
  assert.ok(grouped.some(item => item.kind === 'message' && item.message.id === 'reply'));
  assert.equal(grouped.filter(item => item.kind === 'message').length, 2);
});

test('失败提示位于所属运行最后一条正文之后，工具过程说明仍合并到同一轨迹', () => {
  const anchors = [{ commandId: 'command-1', piEntryId: 'reply' }];
  const failed = { ...trace, status: 'failed' as const };
  const grouped = groupAssistantTimeline(mergeAssistantTimeline(history, tools, anchors, new Set(), [failed]), [failed], anchors);
  assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'reply', 'trace']);
  const last = grouped.at(-1);
  assert.ok(last?.kind === 'trace');
  assert.equal(last.commandId, 'command-1');
  assert.equal(last.replyFollows, false);
  assert.deepEqual(last.notes?.map(note => note.id), ['note-1', 'note-2']);
});

test('失败提示在无工具的连续流式正文末尾，历史恢复和分页也使用同一归属', () => {
  const failed: RunTrace = { ...trace, status: 'failed', entries: trace.entries.filter(entry => entry.kind === 'message') };
  const anchors = [{ commandId: 'command-1', piEntryId: 'reply' }];
  for (const [messages, linked] of [
    [history.map(value => value.role === 'assistant' ? { ...value, commandId: 'command-1', streamCursor: 18 } : value), []],
    [history, anchors],
    [history.slice(1), anchors],
  ] as const) {
    const grouped = groupAssistantTimeline(mergeAssistantTimeline(messages, [], linked), [failed], linked);
    assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), [...messages.map(value => value.id), 'trace']);
    assert.ok(grouped.at(-1)?.kind === 'trace');
  }
});

test('失败提示只有历史锚点而没有正文位置标记时，也在锚点回复之后', () => {
  const messages = history.map(value => { const item = { ...value }; delete item.runtimeMessageId; return item; });
  const anchors = [{ commandId: 'command-1', piEntryId: 'reply' }];
  const failed = { ...trace, status: 'failed' as const, entries: [] };
  const grouped = groupAssistantTimeline(mergeAssistantTimeline(messages, [], anchors), [failed], anchors);
  assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'note-1', 'note-2', 'reply', 'trace']);
});

test('失败提示不会随后续回复移动，也不将其他命令的正文认作本轮输出', () => {
  const failed: RunTrace = { ...trace, status: 'failed', entries: trace.entries.filter(entry => entry.kind === 'message') };
  const later = [
    message('user-next', 'user', '后续提问', '2026-09-27T08:00:10.000Z'),
    message('reply-next', 'assistant', '后续回复', '2026-09-27T08:00:12.000Z', { commandId: 'next-command', runtimeMessageId: 'assistant:3' }),
  ];
  const anchors = [{ commandId: 'command-1', piEntryId: 'reply' }];
  for (const linked of [anchors, []]) {
    const grouped = groupAssistantTimeline(mergeAssistantTimeline([...history, ...later], [], linked), [failed], linked);
    assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'note-1', 'note-2', 'reply', 'trace', 'user-next', 'reply-next']);
  }
  const canonicalLater = later.map(value => { const item = { ...value }; delete item.commandId; return item; });
  const restored = groupAssistantTimeline(mergeAssistantTimeline([...history, ...canonicalLater], [], anchors), [failed], anchors);
  assert.deepEqual(restored.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'note-1', 'note-2', 'reply', 'trace', 'user-next', 'reply-next']);
});

test('失败提示锚点正文已收进过程说明时，不跟随下一轮相同正文 ID 的历史回复', () => {
  const failed = { ...trace, status: 'failed' as const, entries: trace.entries.slice(0, -1) };
  const anchors = [{ commandId: 'command-1', piEntryId: 'note-2' }];
  const messages = [...history.slice(0, 3),
    message('user-next', 'user', '后续提问', '2026-09-27T08:00:10.000Z'),
    message('reply-next', 'assistant', '后续回复', '2026-09-27T08:00:12.000Z', { runtimeMessageId: 'assistant:2' }),
  ];
  const grouped = groupAssistantTimeline(mergeAssistantTimeline(messages, tools, anchors, new Set(), [failed]), [failed], anchors);
  assert.deepEqual(grouped.map(item => item.kind === 'trace' ? 'trace' : item.message.id), ['user-1', 'trace', 'user-next', 'reply-next']);
});
