import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent, ToolAuthorizationRequest, ToolAuthorizationStatus } from '@multivac/contracts';
import { runTraceSummary } from '../src/features/assistant/run-trace-summary.js';
import {
  applyRunTraceEvent,
  applyToolExecutionEvent,
  awaitingAuthorization,
  toolExecutionStateLabel,
  type RunTrace,
  type ToolExecution,
} from '../src/features/assistant/tool-executions.js';

const AT = '2026-09-28T08:00:00.000Z';
let cursor = 10;

function event<T extends AssistantPublicEvent['type']>(
  type: T,
  data: Extract<AssistantPublicEvent, { type: T }>['data'],
  occurredAt = AT,
): AssistantPublicEvent {
  cursor += 1;
  return {
    cursor: String(cursor), eventId: `event-${cursor}`, assistantSessionId: 'global-coordinator',
    commandId: 'command-1', occurredAt, type, data,
  } as AssistantPublicEvent;
}

function request(status: ToolAuthorizationStatus, extra: Partial<ToolAuthorizationRequest> = {}): ToolAuthorizationRequest {
  return {
    requestId: 'request-1', sessionId: 'global-coordinator', commandId: 'command-1', toolName: 'write',
    toolCallId: 'tool-1', requestedPath: '../outside.txt', targetPath: '/work/outside.txt',
    workingDirectory: { kind: 'multivac', path: '/work/multivac' }, status, createdAt: AT,
    expiresAt: '2026-09-28T08:30:00.000Z', decidedAt: status === 'pending' ? null : '2026-09-28T08:00:05.000Z',
    ...extra,
  };
}

const started = () => applyToolExecutionEvent([], event('assistant.tool.started', {
  toolCallId: 'tool-1', toolName: 'write', inputText: 'path: ../outside.txt', inputTruncated: false,
}));

const requested = (records: readonly ToolExecution[]) =>
  applyToolExecutionEvent(records, event('assistant.authorization.requested', { request: request('pending') }));

const resolved = (records: readonly ToolExecution[], status: ToolAuthorizationStatus) =>
  applyToolExecutionEvent(records, event('assistant.authorization.resolved', { request: request(status) }));

const ended = (records: readonly ToolExecution[], isError: boolean, occurredAt = '2026-09-28T08:00:06.000Z') =>
  applyToolExecutionEvent(records, event('assistant.tool.ended', { toolCallId: 'tool-1', toolName: 'write', isError }, occurredAt));

test('工具开始后请求授权：记录转为待授权，不显示执行中；批准后才转为执行中并照常结束', () => {
  const waiting = requested(started());
  assert.equal(waiting[0]!.status, 'awaiting_authorization');
  assert.equal(waiting[0]!.summary, '写入文件等待授权');
  assert.equal(toolExecutionStateLabel(waiting[0]!), '待授权');
  assert.equal(awaitingAuthorization(waiting), true);

  const approved = resolved(waiting, 'approved');
  assert.equal(approved[0]!.status, 'running');
  assert.deepEqual(approved[0]!.authorization, { requestId: 'request-1', status: 'approved' });
  assert.equal(toolExecutionStateLabel(approved[0]!), '执行中');
  assert.equal(awaitingAuthorization(approved), false);

  const done = ended(approved, false);
  assert.equal(done[0]!.status, 'succeeded');
  assert.equal(toolExecutionStateLabel(done[0]!), '已完成');
});

test('未获批准的调用没有执行：按授权结果收尾，结束事件只补上结束位置，不改成执行失败', () => {
  const denied = resolved(requested(started()), 'denied');
  assert.equal(denied[0]!.status, 'failed');
  assert.equal(denied[0]!.isError, true);
  assert.equal(denied[0]!.endedAt, '2026-09-28T08:00:05.000Z');
  assert.equal(toolExecutionStateLabel(denied[0]!), '已拒绝');

  const settled = ended(denied, true);
  assert.equal(settled[0]!.status, 'failed');
  assert.equal(settled[0]!.endedAt, '2026-09-28T08:00:06.000Z');
  assert.equal(settled[0]!.cursor, String(cursor));
  assert.equal(toolExecutionStateLabel(settled[0]!), '已拒绝');

  // 其余终态各有明确标签；失效时结束事件永远不会到达，记录以失效时间结束。
  const labels = (['cancelled', 'expired', 'invalidated'] as const).map((status) => {
    const [record] = resolved(requested(started()), status);
    assert.equal(record!.status, 'failed');
    assert.equal(record!.endedAt, '2026-09-28T08:00:05.000Z');
    return toolExecutionStateLabel(record!);
  });
  assert.deepEqual(labels, ['已取消', '已过期', '已失效']);
});

test('没有请求授权的调用沿用执行状态标签', () => {
  assert.equal(toolExecutionStateLabel({ status: 'running', authorization: null }), '执行中');
  assert.equal(toolExecutionStateLabel({ status: 'failed', authorization: null }), '失败');
  assert.equal(toolExecutionStateLabel({ status: 'succeeded', authorization: null }), '已完成');
});

test('轨迹摘要：等待授权时说明在等授权，而不是思考中', () => {
  assert.equal(runTraceSummary({ running: true, awaitingAuthorization: true, startedAt: AT }), '等待授权');
  assert.equal(runTraceSummary({ running: true, awaitingAuthorization: false, startedAt: AT }), '思考中');
  // 结束后不再受授权影响。
  assert.equal(runTraceSummary({ running: false, awaitingAuthorization: true, startedAt: AT, endedAt: '2026-09-28T08:00:03.000Z' }), '用时 3 秒');
});

test('命令终结而运行没有终态（等待授权时重启）：轨迹随对账结束，不新建也不改写已有终态', () => {
  const running = applyRunTraceEvent([], event('assistant.run.processing', {}));
  const reconciled = (outcome: 'failed' | 'succeeded') => event('assistant.command.reconciled', {
    status: 'terminal', terminalOutcome: outcome,
    error: outcome === 'failed' ? { code: 'COMMAND_INTERRUPTED', message: '已中断' } : null,
  }, '2026-09-28T08:05:00.000Z');

  const interrupted = applyRunTraceEvent(running, reconciled('failed'));
  assert.equal(interrupted[0]!.status, 'failed');
  // 对账时间不是运行结束时间：不给出用时，摘要回退为“已结束”。
  assert.equal(interrupted[0]!.endedAt, null);
  assert.equal(runTraceSummary({ running: false, startedAt: interrupted[0]!.startedAt, endedAt: interrupted[0]!.endedAt }), '已结束');

  const succeeded: RunTrace[] = applyRunTraceEvent(running, event('assistant.run.succeeded', {}));
  assert.equal(applyRunTraceEvent(succeeded, reconciled('failed'))[0]!.status, 'succeeded');
  assert.deepEqual(applyRunTraceEvent([], reconciled('failed')), []);
});
