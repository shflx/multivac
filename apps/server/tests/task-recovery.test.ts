import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';
import type { Task, TaskRun } from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { HumanRequestService } from '../src/application/human-request-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskScheduler } from '../src/application/task-scheduler.js';
import { TaskService } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

function fixture() {
  const store = new SqliteAssistantStore(':memory:');
  const events = new WorkbenchEvents();
  const assistantEvents = new AssistantEventStream();
  const tasks = new TaskService({ facts: store.taskFacts, events, requireProject: () => {} });
  let sends = 0;
  let processesStopped = true;
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: assistantEvents,
    prepare: async () => { throw new Error('恢复必须保留原目录'); },
    createSession: async () => {}, requiredProcessesStopped: () => processesStopped,
    runtime: () => ({ commands: {
      currentPromptCommandId: () => null, cancel: async () => { throw new Error('旧服务已经退出'); },
      send: async (command) => {
        sends++;
        return { ...command, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null,
          piSessionId: 'pi', piEntryId: 'checkpoint', piTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  let scheduler: TaskScheduler | undefined;
  let requests: HumanRequestService | undefined;
  const startRequests = () => {
    requests?.dispose();
    requests = new HumanRequestService({ tasks, runs: store.taskRuns, requests: store.humanRequests, execution, events, assistantEvents,
      authorization: { list: () => [], decide: () => { throw new Error('测试不涉及授权'); } },
      reviewArtifact: () => { throw new Error('测试不涉及成果审核'); },
    });
    return requests;
  };
  return { store, tasks, execution, events, startRequests, sends: () => sends,
    setProcessesStopped(value: boolean) { processesStopped = value; },
    recover() { scheduler = new TaskScheduler(tasks, execution, store.taskRuns, store.taskRuntime, events); },
    reconcile() { scheduler!.reconcileProcessExits(); },
    seed(id: string, status: Task['status'] = 'running', stopConfirmed = false, nativePendingIds: string[] = []) {
      const task = tasks.create({ commandId: `create:${id}`, title: id, goal: '核对已有成果' }).task;
      const run: TaskRun = { runId: `run:${id}`, taskId: task.taskId, sessionId: `session:${id}`, commandId: `command:${id}`,
        status: 'recovery', stopIntent: null, stopConfirmed, ownerId: 'old-service', ownerPid: 99999999,
        hasStarted: true, nativeLeaseFenced: true, nativePendingIds, pendingToolIds: [], toolFailures: 0,
        directory: { kind: 'task-isolated', path: `/test-only/${id}` }, baseline: null, projectId: null, goal: task.goal, scope: '',
        piSessionId: 'pi', piEntryId: 'checkpoint', reason: '旧执行等待恢复', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.taskRuns.save(run);
      tasks.transition(task.taskId, { commandId: `seed:${id}`, key: id, kind: 'fixture', summary: '模拟旧服务的持久化运行' },
        current => ({ ...current, status, pauseSource: 'environment', currentRunId: run.runId, sessionId: run.sessionId }));
      return { task: tasks.get(task.taskId), run };
    },
    async close() { await execution.idle(); requests?.dispose(); scheduler?.dispose(); execution.dispose(); store.close(); },
  };
}

test('启动先确认旧执行停止，再补建恢复请求；用户决定后复用原目录和会话', async () => {
  const f = fixture();
  try {
    const { task, run } = f.seed('restart');
    f.recover();
    assert.equal(f.tasks.get(task.taskId).status, 'recovery');
    assert.equal(f.store.taskRuns.get(run.runId)?.stopConfirmed, true);
    assert.equal(f.store.taskRuns.active().length, 0);
    const requests = f.startRequests();
    const pending = requests.list(task.taskId);
    assert.equal(pending.length, 1);
    const request = pending[0]!;
    assert.equal(request.kind, 'recovery');
    assert.equal(request.runId, run.runId);
    assert.equal(request.status, 'pending');
    assert.equal(request.recovery?.canResume, true);
    assert.equal(f.sends(), 0);
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'bypass-request', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /原人工请求/);
    const input = { commandId: 'confirm-continue', revision: request.revision, decision: 'continue' as const };
    await requests.decide(request.requestId, input);
    await f.execution.idle();
    assert.equal(f.sends(), 1);
    const next = f.store.taskRuns.get(f.tasks.get(task.taskId).currentRunId!)!;
    assert.notEqual(next.runId, run.runId);
    assert.equal(next.sessionId, run.sessionId);
    assert.deepEqual(next.directory, run.directory);
    await requests.decide(request.requestId, input);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
  } finally { await f.close(); }
});

test('补齐已有等待恢复任务时遍历全部分页，重复初始化保留已有请求及草稿', async () => {
  const f = fixture();
  try {
    const legacy = f.seed('legacy', 'recovery', true);
    const now = new Date().toISOString();
    f.store.humanRequests.save({ requestId: 'legacy-request', taskId: legacy.task.taskId, runId: legacy.run.runId,
      sessionId: legacy.run.sessionId, kind: 'recovery', revision: 3, status: 'pending', question: '旧版本恢复问题',
      artifactVersionId: null, authorizationRequestId: null, decision: null, answer: '保留的输入', reason: '', createdAt: now, updatedAt: now });
    for (let i = 0; i < 101; i++) f.seed(`history-${i}`, 'recovery', true);
    f.recover();
    let requests = f.startRequests();
    const before = requests.list();
    assert.equal(before.length, 102);
    assert.ok(before.every(request => request.kind === 'recovery' && request.status === 'pending'));
    assert.equal(requests.get('legacy-request').revision, 3);
    assert.equal(requests.get('legacy-request').answer, '保留的输入');
    requests = f.startRequests();
    assert.deepEqual(requests.list(), before);
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

for (const blocker of ['native-tool', 'process'] as const) test(`恢复请求不绕过停止证明：${blocker}`, async () => {
  const f = fixture();
  try {
    const { task, run } = f.seed(blocker, 'running', false, blocker === 'native-tool' ? ['unconfirmed-tool'] : []);
    f.setProcessesStopped(blocker !== 'process');
    f.recover();
    const requests = f.startRequests();
    const request = requests.list(task.taskId)[0]!;
    assert.equal(request.status, 'pending');
    assert.equal(request.recovery?.canResume, false);
    await assert.rejects(requests.decide(request.requestId, { commandId: 'unsafe-continue', revision: request.revision, decision: 'continue' }), /停止尚不能确认/);
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'unsafe-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /原人工请求|未确认停止/);
    assert.equal(f.store.taskRuns.get(run.runId)?.stopConfirmed, false);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 1);
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});

test('保持停止的决定跨请求服务重建保留，退出证明补齐后允许用户显式继续', async () => {
  const f = fixture();
  try {
    const { task, run } = f.seed('late-proof');
    f.setProcessesStopped(false);
    f.recover();
    let requests = f.startRequests();
    const request = requests.list(task.taskId)[0]!;
    const decision = { commandId: 'stay-stopped', revision: request.revision, decision: 'stop' as const };
    const answered = await requests.decide(request.requestId, decision);
    assert.equal(requests.pending(task.taskId), false);
    assert.equal(f.tasks.get(task.taskId).status, 'recovery');
    requests = f.startRequests();
    assert.equal(requests.pending(task.taskId), false);
    assert.equal(requests.get(request.requestId).status, 'answered');
    f.setProcessesStopped(true);
    f.reconcile();
    assert.equal(f.store.taskRuns.get(run.runId)?.stopConfirmed, true);
    assert.equal(f.tasks.get(task.taskId).status, 'recovery');
    assert.equal(requests.pending(task.taskId), false);
    assert.equal(f.sends(), 0);
    assert.deepEqual(await requests.decide(request.requestId, decision), { ...answered, stopConfirmed: true, recovery: requests.get(request.requestId).recovery });
    await f.execution.control(task.taskId, { commandId: 'explicit-continue', revision: f.tasks.get(task.taskId).revision, action: 'resume' });
    await f.execution.idle();
    assert.equal(f.sends(), 1);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
  } finally { await f.close(); }
});

test('没有待处理请求且旧执行已停止的 recovery 任务接受显式继续，命令重放不重复执行', async () => {
  const f = fixture();
  try {
    const { task, run } = f.seed('explicit-resume', 'recovery', true);
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'wrong-start', revision: task.revision, action: 'start' }), /继续|恢复/);
    const input = { commandId: 'resume', revision: task.revision, action: 'resume' as const };
    const receipt = await f.execution.control(task.taskId, input);
    await f.execution.idle();
    assert.equal(f.sends(), 1);
    assert.deepEqual(await f.execution.control(task.taskId, input), receipt);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 2);
    assert.equal(f.tasks.get(task.taskId).sessionId, run.sessionId);
  } finally { await f.close(); }
});

for (const blocker of ['missing-run', 'unconfirmed-stop', 'pending-tool', 'cancelled-run'] as const) test(`显式继续 recovery 仍核对原执行：${blocker}`, async () => {
  const f = fixture();
  try {
    const { task, run } = f.seed(blocker, 'recovery', blocker !== 'unconfirmed-stop');
    if (blocker === 'pending-tool') f.store.taskRuns.save({ ...run, pendingToolIds: ['unconfirmed-tool'] });
    if (blocker === 'cancelled-run') f.store.taskRuns.save({ ...run, stopIntent: 'cancel' });
    if (blocker === 'missing-run') f.tasks.transition(task.taskId, { commandId: 'missing-run', key: blocker, kind: 'fixture', summary: '缺失原执行' }, current => ({ ...current, currentRunId: null }));
    await assert.rejects(f.execution.control(task.taskId, { commandId: 'blocked-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /原执行|未确认停止|工具副作用|取消意图/);
    assert.equal(f.store.taskRuns.list(task.taskId).length, 1);
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
});


for (const canResume of [false, true]) test(`真实应用重启补齐 Inbox 恢复请求并保留原决定，停止已确认=${canResume}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-restart-recovery-'));
  const environment = testApplicationEnvironment(root);
  let adapter = new FakeCoordinatorAdapter();
  let app = createMultivacApplication(environment, { coordinatorAdapter: adapter });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'restart-task', title: '重启恢复核对', goal: '保留原工作目录与检查点' }).task;
    const databasePath = app.paths.databasePath;
    await app.close();
    const store = new SqliteAssistantStore(databasePath);
    try {
      const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {} });
      const at = new Date().toISOString();
      const run: TaskRun = { runId: 'restart-run', taskId: task.taskId, sessionId: 'restart-session', commandId: 'old-command',
        status: 'running', stopIntent: null, stopConfirmed: false, ownerId: 'old-service', ownerPid: 99999999,
        hasStarted: true, nativeLeaseFenced: true, nativePendingIds: canResume ? [] : ['unconfirmed-tool'], pendingToolIds: [], toolFailures: 0,
        directory: { kind: 'task-isolated', path: join(root, 'work', 'old-task') }, baseline: null,
        projectId: null, goal: task.goal, scope: '', piSessionId: 'old-pi', piEntryId: 'old-checkpoint',
        reason: '旧服务执行中', createdAt: at, updatedAt: at };
      store.taskRuns.save(run);
      tasks.transition(task.taskId, { commandId: 'seed-old-run', key: task.taskId, kind: 'fixture', summary: '模拟进程重启前的持久化事实' },
        current => ({ ...current, status: 'running', currentRunId: run.runId, sessionId: run.sessionId }));
    } finally { store.close(); }
    adapter = new FakeCoordinatorAdapter();
    app = createMultivacApplication(environment, { coordinatorAdapter: adapter });
    await app.ready;
    assert.equal(app.tasks.get(task.taskId).status, 'recovery');
    const request = app.humanRequests.list(task.taskId)[0]!;
    assert.equal(request.kind, 'recovery');
    assert.equal(request.runId, 'restart-run');
    assert.equal(request.recovery?.canResume, canResume);
    assert.equal(request.recovery?.checkpoint, 'old-checkpoint');
    assert.equal(app.inbox.get(request.requestId).human?.requestId, request.requestId);
    assert.equal(adapter.calls.some(call => call.method === 'prompt'), false);
    await app.close();
    app = createMultivacApplication(environment, { coordinatorAdapter: new FakeCoordinatorAdapter() });
    await app.ready;
    assert.deepEqual(app.humanRequests.list(task.taskId), [request]);
    assert.equal(app.tasks.detail(task.taskId).runs?.length, 1);
    if (!canResume) {
      await app.humanRequests.decide(request.requestId, { commandId: 'keep-stopped', revision: request.revision, decision: 'stop' });
      assert.equal(app.humanRequests.pending(task.taskId), false);
      await app.close();
      app = createMultivacApplication(environment, { coordinatorAdapter: new FakeCoordinatorAdapter() });
      await app.ready;
      assert.equal(app.tasks.get(task.taskId).status, 'recovery');
      assert.equal(app.humanRequests.pending(task.taskId), false);
      assert.equal(app.humanRequests.list(task.taskId).length, 1);
      assert.equal(app.humanRequests.get(request.requestId).decision, 'stop');
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
