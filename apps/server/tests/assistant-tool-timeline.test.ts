import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantToolExecutionView } from '@multivac/contracts';
import {
  applyToolExecutionEvent,
  applyRunTraceEvent,
  groupAssistantTimeline,
  hydrateToolExecutions,
  mergeAssistantTimeline,
  renderableRunTraceEntries,
  withoutCommand,
  type ToolExecution,
} from '../../web/src/features/assistant/tool-executions.js';
import type { VisibleAssistantMessage } from '../../web/src/features/assistant/streaming-messages.js';

function message(id: string, createdAt: string, streamCursor?: number): VisibleAssistantMessage {
  return {
    id,
    piSessionId: 'pi-1',
    piEntryId: id,
    role: id.includes('user') ? 'user' : 'assistant',
    text: id,
    createdAt,
    ...(streamCursor === undefined ? {} : { streamCursor }),
  };
}

function toolView(
  toolCallId: string,
  startedAt: string,
  overrides: Partial<AssistantToolExecutionView> = {},
): AssistantToolExecutionView {
  return {
    toolCallId,
    toolName: 'bash',
    displayName: '执行命令',
    commandId: 'command-1',
    cursor: '5',
    status: 'succeeded',
    summary: '执行命令完成',
    detail: 'command: ls',
    isError: false,
    startedAt,
    endedAt: startedAt,
    ...overrides,
  };
}

test('时间线把工具记录插回所属 Turn，而不是堆在会话末尾', () => {
  const messages = [
    message('user-1', '2026-09-18T08:00:00.000Z'),
    message('assistant-1', '2026-09-18T08:00:09.000Z'),
    message('user-2', '2026-09-18T08:01:00.000Z'),
  ];
  const tools = [toolView('tool-1', '2026-09-18T08:00:05.000Z', { commandId: null })];

  assert.deepEqual(
    mergeAssistantTimeline(messages, tools).map((item) =>
      item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
    ['user-1', 'tool:tool-1', 'assistant-1', 'user-2'],
  );
});

test('正文顺序以 Pi 历史为准，跨进程时间戳不改变相对位置', () => {
  // 历史来自更早的时钟；工具与在途正文来自当前进程，仍不能插入历史中间。
  const messages = [
    message('user-1', '2026-09-14T08:00:00.000Z'),
    message('assistant-1', '2026-09-14T08:00:05.000Z'),
  ];
  const merged = mergeAssistantTimeline(
    messages,
    [toolView('tool-now', '2026-09-18T08:00:00.000Z', { commandId: null })],
  );
  assert.deepEqual(merged.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'assistant-1', 'tool:tool-now']);
});

test('多个工具记录按开始时间插入同一 Turn，保持先后顺序', () => {
  const at = '2026-09-18T08:00:00.000Z';
  const merged = mergeAssistantTimeline(
    [message('user-1', at), message('assistant-1', '2026-09-18T08:00:09.000Z')],
    [
      toolView('tool-a', '2026-09-18T08:00:03.000Z', { commandId: null }),
      toolView('tool-b', '2026-09-18T08:00:06.000Z', { commandId: null }),
    ],
  );
  assert.deepEqual(merged.map((item) =>
    item.kind === 'tool' ? item.tool.toolCallId : item.message.id),
  ['user-1', 'tool-a', 'tool-b', 'assistant-1']);
});

test('命令锚点把工具记录放回所属 Turn，锚点不在窗口内的历史记录不展示', () => {
  const messages = [
    message('user-1', '2026-09-18T08:00:00.000Z'),
    message('user-2', '2026-09-18T08:00:30.000Z'),
    message('assistant-2', '2026-09-18T08:00:39.000Z'),
  ];
  messages[2]!.piEntryId = 'entry-turn-2';
  const anchored = mergeAssistantTimeline(
    messages,
    [toolView('tool-anchored', '2026-09-01T00:00:00.000Z', { commandId: 'command-2' })],
    [{ commandId: 'command-2', piEntryId: 'entry-turn-2' }],
  );
  assert.deepEqual(anchored.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'user-2', 'tool:tool-anchored', 'assistant-2']);

  // 所属 Turn 尚未加载：跳过该历史记录，不允许堆到会话顶部。
  const outsideWindow = mergeAssistantTimeline(
    messages,
    [toolView('tool-old', '2026-09-01T00:00:00.000Z', { commandId: 'command-old' })],
    [{ commandId: 'command-old', piEntryId: 'entry-not-loaded' }],
  );
  assert.deepEqual(outsideWindow.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'user-2', 'assistant-2']);

  // 尚无锚点的在途记录按开始时间插入，仍可见。
  const pending = mergeAssistantTimeline(
    messages,
    [toolView('tool-live', '2026-09-18T08:00:35.000Z', { commandId: 'command-live' })],
    [],
  );
  assert.deepEqual(pending.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'user-2', 'tool:tool-live', 'assistant-2']);
});

test('同一 Turn 的多条工具记录按开始时间排在锚点之前', () => {
  const messages = [message('user-1', '2026-09-18T08:00:00.000Z')];
  messages.push({ ...message('assistant-1', '2026-09-18T08:00:39.000Z'), piEntryId: 'entry-turn-1' });
  const merged = mergeAssistantTimeline(
    messages,
    [
      toolView('tool-b', '2026-09-18T08:00:20.000Z', { commandId: 'command-1' }),
      toolView('tool-a', '2026-09-18T08:00:10.000Z', { commandId: 'command-1' }),
    ],
    [{ commandId: 'command-1', piEntryId: 'entry-turn-1' }],
  );
  assert.deepEqual(merged.map((item) =>
    item.kind === 'tool' ? item.tool.toolCallId : item.message.id),
  ['user-1', 'tool-b', 'tool-a', 'assistant-1']);
});

test('在途正文之后开始的工具记录排在其后，已落库历史的相对顺序不变', () => {
  const merged = mergeAssistantTimeline(
    [
      message('user-1', '2026-09-18T08:00:00.000Z'),
      message('stream:pi-1:assistant:1', '2026-09-18T08:00:03.000Z', 7),
    ],
    [toolView('tool-later', '2026-09-18T08:00:06.000Z', { commandId: null })],
  );
  assert.deepEqual(merged.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'stream:pi-1:assistant:1', 'tool:tool-later']);

  // 早于在途正文的工具记录仍落在正文之前。
  const earlier = mergeAssistantTimeline(
    [
      message('user-1', '2026-09-18T08:00:00.000Z'),
      message('stream:pi-1:assistant:1', '2026-09-18T08:00:09.000Z', 7),
    ],
    [toolView('tool-first', '2026-09-18T08:00:04.000Z', { commandId: null })],
  );
  assert.deepEqual(earlier.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'tool:tool-first', 'stream:pi-1:assistant:1']);
});

test('快照水合保留已展开的明细，事件追加不重复插入同一工具', () => {
  const hydrated = hydrateToolExecutions([], {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-1',
    messages: [],
    hasMore: false,
    nextBefore: null,
    cursor: 'pi-1:entry-1',
    eventCursor: '9',
    toolExecutions: [toolView('tool-1', '2026-09-18T08:00:05.000Z', { commandId: null })],
  });
  const withDetail: ToolExecution[] = hydrated.map((record) => ({
    ...record,
    detailState: 'ready' as const,
    inputText: 'command: ls',
    inputTruncated: false,
  }));
  const rehydrated = hydrateToolExecutions(withDetail, {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-1',
    messages: [],
    hasMore: false,
    nextBefore: null,
    cursor: 'pi-1:entry-1',
    eventCursor: '12',
    toolExecutions: [toolView('tool-1', '2026-09-18T08:00:05.000Z', { status: 'failed', isError: true })],
  });
  assert.equal(rehydrated[0]?.status, 'failed');
  assert.equal(rehydrated[0]?.detailState, 'ready');
  assert.equal(rehydrated[0]?.inputText, 'command: ls');

  const appended = applyToolExecutionEvent(rehydrated, {
    cursor: '13',
    eventId: 'event:13',
    assistantSessionId: 'global-coordinator',
    commandId: 'command-1',
    occurredAt: '2026-09-18T08:00:06.000Z',
    type: 'assistant.tool.started',
    data: { toolCallId: 'tool-2', toolName: 'read', inputText: 'path: a.ts\nlimit: 200', inputTruncated: false },
  });
  assert.deepEqual(appended.map((record) => record.toolCallId), ['tool-1', 'tool-2']);
  assert.equal(appended[1]?.summary, '正在读取文件');
  assert.equal(appended[1]?.detail, '读取 a.ts');
  assert.deepEqual(
    withoutCommand(appended, 'command-1').map((record) => record.toolCallId),
    [],
  );
});

test('多锚点交错时不因插入位移而串组', () => {
  // tools 按 cursor 排序：B 组较早但锚点位置更靠后，A 组锚点更靠前。
  const messages = [
    message('user-1', '2026-09-18T08:00:00.000Z'),
    { ...message('assistant-1', '2026-09-18T08:00:10.000Z'), piEntryId: 'entry-a' },
    message('user-2', '2026-09-18T08:00:20.000Z'),
    { ...message('assistant-2', '2026-09-18T08:00:30.000Z'), piEntryId: 'entry-b' },
  ];
  const tools = [
    toolView('tool-b1', '2026-09-18T08:00:25.000Z', { commandId: 'command-b' }),
    toolView('tool-a1', '2026-09-18T08:00:05.000Z', { commandId: 'command-a' }),
  ];
  const merged = mergeAssistantTimeline(messages, tools, [
    { commandId: 'command-a', piEntryId: 'entry-a' },
    { commandId: 'command-b', piEntryId: 'entry-b' },
  ]);
  assert.deepEqual(merged.map((item) =>
    item.kind === 'tool' ? `tool:${item.tool.toolCallId}` : item.message.id),
  ['user-1', 'tool:tool-a1', 'assistant-1', 'user-2', 'tool:tool-b1', 'assistant-2']);
});

test('同一命令的相邻工具消息折叠为一组，正文与不同命令切断分组', () => {
  const first = toolView('tool-a1', '2026-09-18T08:00:01.000Z', { commandId: 'command-a' });
  const second = toolView('tool-a2', '2026-09-18T08:00:02.000Z', { commandId: 'command-a' });
  const third = toolView('tool-b1', '2026-09-18T08:00:03.000Z', { commandId: 'command-b' });
  const grouped = groupAssistantTimeline([
    { kind: 'message', key: 'user', message: message('user-1', '2026-09-18T08:00:00.000Z') },
    { kind: 'tool', key: first.startedAt, tool: first },
    { kind: 'tool', key: second.startedAt, tool: second },
    { kind: 'tool', key: third.startedAt, tool: third },
    { kind: 'message', key: 'assistant', message: message('assistant-1', '2026-09-18T08:00:04.000Z') },
  ]);

  assert.equal(grouped[1]?.kind, 'trace');
  if (grouped[1]?.kind === 'trace') {
    assert.deepEqual(grouped[1].tools.map((tool) => tool.toolCallId), ['tool-a1', 'tool-a2']);
  }
  assert.equal(grouped[2]?.kind, 'trace');
  if (grouped[2]?.kind === 'trace') {
    assert.deepEqual(grouped[2].tools.map((tool) => tool.toolCallId), ['tool-b1']);
  }
});

test('thinking 增量按命令累积并与工具组装入同一 Trace', () => {
  const base = {
    assistantSessionId: 'global-coordinator', commandId: 'command-a',
    piSessionId: 'pi-1', messageId: 'assistant:1', occurredAt: '2026-09-18T08:00:01.000Z',
  };
  let traces = applyRunTraceEvent([], {
    ...base, cursor: '1', eventId: 'event:1', type: 'assistant.run.processing', data: {},
  });
  traces = applyRunTraceEvent(traces, {
    ...base, cursor: '2', eventId: 'event:2', type: 'assistant.thinking.delta',
    data: { piSessionId: 'pi-1', messageId: 'assistant:1', delta: '检查分页。', deltaTruncated: false },
  });
  traces = applyRunTraceEvent(traces, {
    ...base, cursor: '3', eventId: 'event:3', type: 'assistant.tool.started',
    data: { toolCallId: 'tool-a', toolName: 'bash', inputText: 'command: test', inputTruncated: false },
  });
  traces = applyRunTraceEvent(traces, {
    ...base, cursor: '4', eventId: 'event:4', type: 'assistant.thinking.delta',
    data: { piSessionId: 'pi-1', messageId: 'assistant:2', delta: '继续整理。', deltaTruncated: false },
  });
  traces = applyRunTraceEvent(traces, {
    ...base, cursor: '5', eventId: 'event:5', type: 'assistant.run.succeeded', data: {},
  });
  assert.deepEqual(traces[0]?.entries, [
    { kind: 'thinking', cursor: '2', text: '检查分页。', truncated: false },
    { kind: 'tool', cursor: '3', toolCallId: 'tool-a' },
    { kind: 'thinking', cursor: '4', text: '继续整理。', truncated: false },
  ]);
  assert.equal(traces[0]?.status, 'succeeded');

  const tool = toolView('tool-a', '2026-09-18T08:00:02.000Z', { commandId: 'command-a' });
  const grouped = groupAssistantTimeline(
    [{ kind: 'tool', key: tool.startedAt, tool }],
    traces,
  );
  assert.equal(grouped[0]?.kind, 'trace');
  if (grouped[0]?.kind === 'trace') {
    assert.deepEqual(grouped[0].trace?.entries, traces[0]?.entries);
    assert.deepEqual(grouped[0].tools.map((item) => item.toolCallId), ['tool-a']);
  }
});

test('无锚点运行 Trace 按 commandId 放在流式回复之前', () => {
  const streaming = message('stream:assistant-1', '2026-09-18T08:00:03.000Z', 5);
  streaming.commandId = 'command-a';
  const trace = {
    commandId: 'command-a', cursor: '4', status: 'running' as const,
    entries: [{ kind: 'thinking' as const, cursor: '4', text: '正在组织回复。', truncated: false }],
    thinkingTruncated: false, startedAt: '2026-09-18T08:00:01.000Z', endedAt: null,
  };
  const grouped = groupAssistantTimeline([
    { kind: 'message', key: streaming.createdAt, message: streaming },
  ], [trace]);
  assert.deepEqual(grouped.map((item) => item.kind), ['trace', 'message']);
});

test('轨迹面板只保留可渲染条目，工具记录已滑出快照窗口的条目被剔除', () => {
  const trace = {
    commandId: 'command-1',
    cursor: '9',
    status: 'succeeded' as const,
    entries: [
      { kind: 'thinking' as const, cursor: '2', text: '先读文件', truncated: false },
      { kind: 'tool' as const, cursor: '3', toolCallId: 'tool-a' },
      { kind: 'tool' as const, cursor: '4', toolCallId: 'tool-evicted' },
    ],
    thinkingTruncated: false,
    startedAt: '2026-09-18T08:00:00.000Z',
    endedAt: '2026-09-18T08:00:09.000Z',
  };
  const records = hydrateToolExecutions([], {
    toolExecutions: [
      toolView('tool-a', '2026-09-18T08:00:03.000Z', { cursor: '3' }),
      toolView('tool-b', '2026-09-18T08:00:05.000Z', { cursor: '5' }),
    ],
  } as never);

  assert.deepEqual(
    renderableRunTraceEntries(trace, records).map((entry) =>
      entry.kind === 'thinking' ? `thinking:${entry.text}` : `tool:${entry.toolCallId}`),
    ['thinking:先读文件', 'tool:tool-a', 'tool:tool-b'],
  );

  // 只有工具条目且记录全部滑出窗口时，没有任何可渲染内容。
  const toolOnly = { ...trace, entries: [{ kind: 'tool' as const, cursor: '4', toolCallId: 'tool-evicted' }] };
  assert.deepEqual(renderableRunTraceEntries(toolOnly, []), []);
});
