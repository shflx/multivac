import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskRun } from '@multivac/contracts';
import {
  assertCanStart, assertControllable, pauseUnfinishedChild, releaseFromCancelledParent, requestStop, returnParentForChildChanges, settleRun,
  type ExecutionOutcome,
} from '../src/modules/tasks/task-control.js';

const at = '2026-01-01T00:00:00.000Z';

function task(patch: Partial<Task> = {}): Task {
  return {
    taskId: 'task', title: '核对', goal: '核对来源', scope: '', projectId: null, groupId: null, parentTaskId: null, dependencyIds: [],
    priority: 'medium', acceptance: true, acceptanceCriteria: '', humanOnly: false, agentId: 'default', status: 'running', revision: 3,
    sessionId: 'session', currentRunId: 'run', reason: '', nextStep: '', createdAt: at, updatedAt: at, completedAt: null, ...patch,
  };
}

function run(patch: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'run', taskId: 'task', sessionId: 'session', commandId: 'task-run:run', status: 'running', stopIntent: null, stopConfirmed: false,
    ownerId: 'owner', directory: null, baseline: null, goal: '核对来源', scope: '', projectId: null, pendingToolIds: [], toolFailures: 0,
    lastEventCursor: 0, piSessionId: null, piEntryId: null, reason: '', createdAt: at, updatedAt: at, hasStarted: true, nativePendingIds: [], ...patch,
  };
}

test('控制前提：取消意图不可被暂停或继续覆盖，终态任务拒绝控制', () => {
  assert.throws(() => assertControllable(task(), run({ stopIntent: 'cancel' }), 'pause'), /取消意图/);
  assert.doesNotThrow(() => assertControllable(task(), run({ stopIntent: 'cancel' }), 'cancel'));
  assert.throws(() => assertControllable(task({ status: 'done' }), null, 'resume'), /终态/);
});

test('启动准入：缺少停止证明、未核对工具或人工门禁未解除时拒绝', () => {
  const admission = { action: 'resume' as const, pendingRequest: false, schedulerManaged: true, dependenciesSatisfied: () => true };
  const paused = task({ status: 'paused' });
  assert.throws(() => assertCanStart(paused, run({ stopConfirmed: false }), admission), /尚未确认停止/);
  assert.throws(() => assertCanStart(paused, run({ stopConfirmed: true, nativePendingIds: ['tool'] }), admission), /未核对工具/);
  assert.throws(() => assertCanStart(paused, run({ stopConfirmed: true }), { ...admission, pendingRequest: true }), /原人工请求/);
  assert.throws(() => assertCanStart(task({ status: 'recovery' }), run({ stopConfirmed: true }), { ...admission, action: 'start' }), /继续操作/);
  assert.throws(() => assertCanStart(paused, null, { ...admission, schedulerManaged: false, dependenciesSatisfied: () => false }), /前置任务/);
  assert.doesNotThrow(() => assertCanStart(paused, run({ stopConfirmed: true }), admission));
});

test('暂停请求：执行中的运行只保存停止意图，必须等待停止证明', () => {
  const decision = requestStop({ task: task(), run: run(), action: 'pause', pauseSource: 'user', unstartedHere: false, ownedHere: true, now: at });
  assert.equal(decision.awaitStop, true);
  assert.equal(decision.run?.stopIntent, 'pause');
  assert.equal(decision.run?.stopConfirmed, false);
  assert.equal(decision.run?.status, 'stopping');
  assert.equal(decision.task.status, 'running');
  assert.equal(decision.task.pauseSource, 'user');
});

test('暂停请求：旧服务遗留的运行进入恢复核对；人工暂停保留原请求说明', () => {
  const decision = requestStop({ task: task({ reason: '需要采用哪个来源？' }), run: run(), action: 'pause', pauseSource: 'human', unstartedHere: false, ownedHere: false, now: at });
  assert.equal(decision.run?.status, 'recovery');
  assert.equal(decision.task.reason, '需要采用哪个来源？');
});

test('取消请求：尚未开始的本地排队运行直接确认停止，不等待执行', () => {
  const decision = requestStop({ task: task({ status: 'queued' }), run: run({ hasStarted: false }), action: 'cancel', pauseSource: 'user', unstartedHere: true, ownedHere: true, now: at });
  assert.equal(decision.awaitStop, false);
  assert.equal(decision.run?.stopConfirmed, true);
  assert.equal(decision.task.status, 'cancelled');
  assert.equal(decision.task.pauseSource, null);
});

test('预算暂停记录耗尽原因；没有活动运行时直接暂停', () => {
  const budget = requestStop({ task: task(), run: run(), action: 'pause', pauseSource: 'budget', unstartedHere: false, ownedHere: true, budgetReason: '执行时长已用完', now: at });
  assert.equal(budget.run?.budgetStopReason, '执行时长已用完');
  const idle = requestStop({ task: task({ status: 'waiting' }), run: run({ stopConfirmed: true }), action: 'pause', pauseSource: 'user', unstartedHere: false, ownedHere: true, now: at });
  assert.deepEqual([idle.run, idle.awaitStop, idle.task.status], [null, false, 'paused']);
  assert.throws(() => requestStop({ task: task({ status: 'idle' }), run: null, action: 'pause', pauseSource: 'user', unstartedHere: false, ownedHere: true, now: at }), /不能暂停/);
});

test('停止确认：依赖进程或工具无法证明停止时保留占用并进入恢复', () => {
  const outcome: ExecutionOutcome = { endedAt: at, receipt: undefined };
  const current = run({ stopIntent: 'pause', pendingToolIds: ['tool'] });
  const next = settleRun(current, task(), { outcome, processesStopped: true, toolsStopped: () => false, budgetReason: () => '', now: at });
  assert.equal(current.stopConfirmed, false);
  assert.equal(current.status, 'recovery');
  assert.equal(outcome.recovery, true);
  assert.equal(next.status, 'recovery');

  const stoppedProcesses = run({ stopIntent: 'pause' });
  settleRun(stoppedProcesses, task(), { outcome: { endedAt: at }, processesStopped: false, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.equal(stoppedProcesses.stopConfirmed, false);
});

test('停止确认：停止证明齐全后按停止意图结算，人工暂停回到等待原请求', () => {
  const tool = run({ stopIntent: 'pause', pendingToolIds: ['tool'] });
  const paused = settleRun(tool, task({ pauseSource: 'user' }), { outcome: { endedAt: at }, processesStopped: true, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.equal(tool.stopConfirmed, true);
  assert.equal(tool.toolFailures, 1);
  assert.deepEqual(tool.pendingToolIds, []);
  assert.equal(paused.status, 'paused');

  const human = settleRun(run({ stopIntent: 'pause' }), task({ pauseSource: 'human' }), { outcome: { endedAt: at }, processesStopped: true, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.equal(human.status, 'waiting');

  const cancelled = settleRun(run({ stopIntent: 'cancel' }), task(), { outcome: { endedAt: at }, processesStopped: true, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.equal(cancelled.status, 'cancelled');
});

test('正常终结：成功等待成果核对，失败保留原因；一轮结束不等于任务完成', () => {
  const receipt = { terminalOutcome: 'succeeded', piSessionId: 'pi', piEntryId: 'entry' } as unknown as ExecutionOutcome['receipt'];
  const settled = run();
  const waiting = settleRun(settled, task(), { outcome: { endedAt: at, receipt }, processesStopped: true, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.deepEqual([settled.status, settled.piEntryId, waiting.status], ['settled', 'entry', 'waiting']);

  const failed = settleRun(run(), task(), { outcome: { endedAt: at, failure: '网络中断' }, processesStopped: true, toolsStopped: () => true, budgetReason: () => '', now: at });
  assert.deepEqual([failed.status, failed.reason], ['failed', '网络中断']);
});

test('任务树：父任务取消后只释放本运行尚未交付的子任务；停止时未登记成果的子项暂停进度', () => {
  const parent = { taskId: 'parent', runId: 'run' };
  const child = task({ taskId: 'child', status: 'waiting', executionTaskId: 'parent', executionProgress: 'processing', currentRunId: 'run' });
  const released = releaseFromCancelledParent(child, parent, false);
  assert.equal(released?.status, 'paused');
  assert.equal(released?.pauseSource, 'user');
  assert.equal(released && 'executionTaskId' in released, false);
  assert.equal(releaseFromCancelledParent(child, parent, true), null, '已交付的子任务不释放');
  assert.equal(releaseFromCancelledParent({ ...child, currentRunId: 'other' }, parent, false), null, '其他运行的子任务不释放');

  assert.equal(pauseUnfinishedChild(child, 'run')?.executionProgress, 'paused');
  assert.equal(pauseUnfinishedChild({ ...child, executionProgress: 'ready' }, 'run'), null, '已登记成果的子项保持就绪');

  const returned = returnParentForChildChanges(task({ taskId: 'parent', status: 'review' }));
  assert.deepEqual([returned.status, returned.pauseSource], ['paused', 'user']);
});
