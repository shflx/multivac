import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantPublicEvent, AssistantRunTraceView } from '@multivac/contracts';
import { applyRunTraceEvent, groupAssistantTimeline, mergeRunTraces } from '../src/features/assistant/tool-executions.js';
import { ToolExecutionGroup } from '../src/features/assistant/tool-execution.js';

const base = { eventId: 'event', assistantSessionId: 'session-a', occurredAt: '2026-10-01T00:00:00.000Z' };
const error = { code: 'MODEL_REQUEST_FAILED', message: 'HTTP 401：认证失败，请核对认证配置。' };
const trace: AssistantRunTraceView = { commandId: 'failed-run', cursor: '2', status: 'failed', error, entries: [], thinkingTruncated: false, startedAt: base.occurredAt, endedAt: base.occurredAt };

function render(value: AssistantRunTraceView, replyVisible = false) {
  return renderToStaticMarkup(createElement(ToolExecutionGroup, { records: [], trace: value, replyVisible }));
}

test('失败运行默认展开原因，即使已有回复或没有思考与工具，原因仍关联本次运行', () => {
  const html = render(trace);
  assert.match(html, /处理失败 · 查看原因/);
  assert.match(html, /<details[^>]* open=""/);
  assert.match(render(trace, true), /<details[^>]* open=""/);
  assert.match(html, /本次运行失败原因/);
  assert.match(html, /HTTP 401：认证失败/);
  assert.match(html, /data-run-command-id="failed-run"/);
  assert.doesNotMatch(html, /本次运行开始于/);
  const missing = { ...trace }; delete missing.error;
  assert.match(render(missing), /原因未提供。/);
  assert.doesNotMatch(render({ ...trace, status: 'cancelled' }), /查看原因|HTTP 401/);
  assert.doesNotMatch(render({ ...trace, status: 'succeeded' }), /查看原因|HTTP 401/);
  // 错误按文本显示，不能注入 HTML。
  assert.doesNotMatch(render({ ...trace, error: { ...error, message: '<script>unsafe()</script>' } }), /<script>/);
});

test('失败原因按 commandId 独立保留，后续运行与迟到中间事件不能覆盖', () => {
  let traces = applyRunTraceEvent([], { ...base, cursor: '1', commandId: 'failed-run', type: 'assistant.run.processing', data: {} });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '2', commandId: 'failed-run', type: 'assistant.run.failed', data: { error } });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '3', commandId: 'next-run', type: 'assistant.run.processing', data: {} });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '4', commandId: 'next-run', type: 'assistant.run.succeeded', data: {} });
  traces = applyRunTraceEvent(traces, { ...base, cursor: '5', commandId: 'failed-run', type: 'assistant.thinking.delta', data: { piSessionId: 'pi-a', messageId: 'late', delta: '迟到事件', deltaTruncated: false } });
  assert.equal(traces.find(value => value.commandId === 'failed-run')?.error?.message, error.message);
  assert.equal(traces.find(value => value.commandId === 'failed-run')?.status, 'failed');
  assert.equal(traces.find(value => value.commandId === 'next-run')?.error, undefined);
  const grouped = groupAssistantTimeline([], traces);
  assert.equal(grouped.some(item => item.kind === 'trace' && item.commandId === 'failed-run'), true);
  const latestOnly = traces.filter(value => value.commandId !== 'failed-run');
  const merged = mergeRunTraces(latestOnly, [trace]);
  assert.equal(merged.find(value => value.commandId === 'failed-run')?.error?.message, error.message);
  assert.equal(mergeRunTraces(merged, latestOnly).find(value => value.commandId === 'failed-run')?.error?.message, error.message);
});

test('prompt 提前失败对账可恢复原因；等待授权、工具失败和重试失败本身不终结运行', () => {
  let traces = applyRunTraceEvent([], { ...base, cursor: '1', commandId: 'early', type: 'assistant.command.handed_to_pi', data: { kind: 'send', dispatchMode: 'prompt' } });
  const intermediate: AssistantPublicEvent[] = [
    { ...base, cursor: '2', commandId: 'early', type: 'assistant.tool.ended', data: { toolCallId: 't', toolName: 'read', isError: true } },
    { ...base, cursor: '3', commandId: 'early', type: 'assistant.retry.ended', data: { scope: 'run', attempt: 1, outcome: 'failed' } },
    { ...base, cursor: '4', commandId: 'early', type: 'assistant.compaction.ended', data: { reason: 'threshold', status: 'failed', willRetry: true } },
  ];
  for (const event of intermediate) traces = applyRunTraceEvent(traces, event);
  assert.equal(traces[0]?.status, 'running');
  assert.equal(traces[0]?.error, undefined);
  traces = applyRunTraceEvent(traces, { ...base, cursor: '5', commandId: 'early', type: 'assistant.command.reconciled', data: { status: 'terminal', terminalOutcome: 'failed', error } });
  assert.equal(traces[0]?.error?.message, error.message);
  assert.equal(traces[0]?.endedAt, null);
  // 追加消息的 accepted 回执不冒充运行失败。
  assert.deepEqual(applyRunTraceEvent([], { ...base, cursor: '6', commandId: 'queue', type: 'assistant.command.reconciled', data: { status: 'terminal', terminalOutcome: 'accepted', error: null } }), []);
});
