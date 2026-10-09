import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupAssistantTimeline, mergeAssistantTimeline, type RunTrace, type ToolExecution } from '../src/features/assistant/tool-executions.js';
import { ToolExecutionGroup } from '../src/features/assistant/tool-execution.js';
import type { VisibleAssistantMessage } from '../src/features/assistant/streaming-messages.js';

const message = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<VisibleAssistantMessage> = {}): VisibleAssistantMessage => ({
  id, piSessionId: 'pi', piEntryId: id, role, text, createdAt: '2026-10-09T08:00:00.000Z', ...extra,
});
const old = message('old-user', 'user', '重启前的提问');
const next = message('next-user', 'user', '新的提问');
const reply = message('next-reply', 'assistant', '新问题的正常回复');
const interrupted: RunTrace = { commandId: 'old-command', cursor: '200', status: 'failed', thinkingTruncated: false,
  entries: [], startedAt: old.createdAt, endedAt: null,
  error: { code: 'COMMAND_INTERRUPTED', message: '服务重启前命令尚未终结；provider stream 不可跨进程恢复，已标记为中断。' },
};
const order = (items: ReturnType<typeof groupAssistantTimeline>) => items.map(item => item.kind === 'trace' ? `error:${item.commandId}` : item.message.id);

function timeline(messages: VisibleAssistantMessage[], trace = interrupted, anchors: { commandId: string; piEntryId: string }[] = [], tools: ToolExecution[] = []) {
  return groupAssistantTimeline(mergeAssistantTimeline(messages, tools, anchors, new Set(), [trace]), [trace], anchors);
}

test('旧中断没有可验证归属时独立展示，新增消息、回复和分页不把错误追加到末尾', () => {
  for (const messages of [[old], [old, next], [old, next, reply], [next, reply]]) {
    const items = timeline(messages);
    assert.deepEqual(order(items), ['error:old-command', ...messages.map(message => message.id)]);
    const detached = items[0]!;
    assert.ok(detached.kind === 'trace' && detached.unanchored);
    const html = renderToStaticMarkup(createElement(ToolExecutionGroup, { records: [], trace: detached.trace!, unanchored: detached.unanchored, replyVisible: false }));
    assert.match(html, /历史处理失败 · 查看原因/);
    assert.match(html, /未关联消息的历史运行记录/);
    assert.match(html, /provider stream/);
  }
});

test('中断前没有回复时，持久化用户锚点让错误固定在原提问之后', () => {
  const anchors = [{ commandId: interrupted.commandId, piEntryId: old.piEntryId }];
  assert.deepEqual(order(timeline([old, next, reply], interrupted, anchors)), ['old-user', 'error:old-command', 'next-user', 'next-reply']);
  // 原轮次不在分页窗口里时，等加载到原消息再显示；不挂到新消息上。
  assert.deepEqual(order(timeline([next, reply], interrupted, anchors)), ['next-user', 'next-reply']);
});

test('旧中断缺少回执锚点但有唯一正文身份时，仍放回原回复之后', () => {
  const previousReply = message('old-reply', 'assistant', '中断前的部分正文', { runtimeMessageId: 'old-output' });
  const trace = { ...interrupted, entries: [{ kind: 'message' as const, cursor: '3', messageId: 'old-output' }] };
  assert.deepEqual(order(timeline([old, previousReply, next, reply], trace)), ['old-user', 'old-reply', 'error:old-command', 'next-user', 'next-reply']);
});

test('重复正文身份不能把旧错误关联到新的回复', () => {
  const previousReply = message('old-reply', 'assistant', '之前的正文', { runtimeMessageId: 'reused' });
  const nextReply = { ...reply, runtimeMessageId: 'reused' };
  const trace = { ...interrupted, entries: [{ kind: 'message' as const, cursor: '3', messageId: 'reused' }] };
  const items = timeline([old, previousReply, next, nextReply], trace);
  assert.deepEqual(order(items), ['error:old-command', 'old-user', 'old-reply', 'next-user', 'next-reply']);
  assert.ok(items[0]?.kind === 'trace' && items[0].unanchored);
});

test('无归属失败的工具记录不参加新轮次折叠，不会吞掉新回复', () => {
  const tools: ToolExecution[] = [{ commandId: interrupted.commandId, toolCallId: 'old-tool', toolName: 'read', displayName: '读取文件',
    cursor: '3', status: 'failed', summary: '读取失败', detail: null, isError: true, startedAt: '2026-10-09T09:00:00.000Z', endedAt: null,
    detailState: 'absent', authorization: null,
  }];
  const trace = { ...interrupted, entries: [{ kind: 'tool' as const, cursor: '3', toolCallId: 'old-tool' }] };
  const items = timeline([old, next, reply], trace, [], tools);
  assert.deepEqual(order(items), ['error:old-command', 'old-user', 'next-user', 'next-reply']);
  assert.ok(items[0]?.kind === 'trace' && items[0].tools.length === 1 && items[0].notes === undefined);
});
