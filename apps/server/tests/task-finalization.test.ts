import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskExecutionService, type TaskExecutionOptions } from '../src/application/task-execution-service.js';
import { TaskScheduler } from '../src/application/task-scheduler.js';
import { TaskService } from '../src/application/task-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { HumanRequestService } from '../src/application/human-request-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import type { Task } from '@multivac/contracts';

const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function fixture(options: Partial<TaskExecutionOptions> = {}, path = ':memory:', failSend = false) {
  const store = new SqliteAssistantStore(path);
  const events = new WorkbenchEvents();
  const stream = new AssistantEventStream();
  // 用例按需接入人工请求服务等提交后的协作。
  let afterCommit: (task: Task) => void = () => {};
  const tasks = new TaskService({ afterCommit: (task) => afterCommit(task), facts: store.taskFacts, requireProject: () => {}, events });
  let sends = 0;
  const execution = new TaskExecutionService({ settleArtifacts: async () => {},
    tasks, runs: store.taskRuns, events: stream, stopTimeoutMs: 10,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: '/test-only' }, baseline: null }),
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null, cancel: async () => ({} as any),
      send: async () => { sends++; if (failSend) throw new Error('ECONNRESET'); return { terminalOutcome: 'succeeded', runtimeEntryId: 'checkpoint', runtimeSessionId: 'pi' } as any; },
    } }), ...options,
  });
  const task = tasks.create({ commandId: 'create', title: '收尾故障注入', goal: '核对' }).task;
  return { store, tasks, execution, task, events, stream, onCommit(reaction: (task: Task) => void) { afterCommit = reaction; },
    current: () => tasks.get(task.taskId), run: () => store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!,
    start: async () => { await execution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' }); await flush(); },
    sends: () => sends, close: () => { execution.dispose(); store.close(); },
  };
}

for (const failSend of [false, true]) test(`原执行${failSend ? '网络失败' : '成功'}后清理抛错，独立保存错误且不遗留 running`, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let stopped = false;
  const f = fixture({ stopRequiredProcesses: async () => { throw new Error('停止依赖异常'); }, requiredProcessesStopped: () => stopped }, ':memory:', failSend);
  try {
    await f.start(); await f.execution.idle();
    assert.equal(f.current().status, 'recovery');
    assert.equal(f.run().status, 'recovery');
    assert.equal(f.run().stopConfirmed, false);
    assert.ok(f.run().executionEndedAt);
    assert.equal(f.run().cleanupError, '停止依赖异常');
    assert.equal(f.run().executionError, failSend ? 'ECONNRESET' : undefined);
    assert.equal(logs.mock.callCount(), 1);
    await assert.rejects(f.execution.control(f.task.taskId, { commandId: 'unsafe', revision: f.current().revision, action: 'resume' }), /尚未确认停止/);
    stopped = true;
    await Promise.all([f.execution.reconcileFinalizations(), f.execution.reconcileFinalizations()]);
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.current().status, 'recovery');
    assert.equal(f.run().cleanupError, '停止依赖异常');
    assert.equal(f.sends(), 1);
    const revision = f.current().revision;
    await f.execution.reconcileFinalizations();
    assert.equal(f.current().revision, revision);
  } finally { f.close(); }
});

for (const failSend of [false, true]) test(`正常${failSend ? '失败' : '成功'}收尾不改变验收边界`, async () => {
  const f = fixture({}, ':memory:', failSend);
  try {
    await f.start(); await f.execution.idle();
    assert.equal(f.current().status, failSend ? 'failed' : 'waiting');
    assert.equal(f.run().status, failSend ? 'failed' : 'settled');
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.current().completedAt, null);
    assert.equal(f.run().cleanupError, undefined);
  } finally { f.close(); }
});

test('部分依赖未退出时保留租约，后续核对停止后仍等待用户决定', async () => {
  let stopped = false;
  let stops = 0;
  const f = fixture({ stopRequiredProcesses: async () => { stops++; return stopped; } });
  try {
    await f.start(); await f.execution.idle();
    assert.equal(f.run().stopConfirmed, false);
    assert.equal(f.current().status, 'recovery');
    stopped = true;
    await f.execution.reconcileFinalizations();
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.current().status, 'recovery');
    assert.equal(stops, 2);
    assert.equal(f.sends(), 1);
    const sessionId = f.run().sessionId;
    await f.execution.control(f.task.taskId, { commandId: 'resume', revision: f.current().revision, action: 'resume' });
    await f.execution.idle();
    assert.equal(f.sends(), 2);
    assert.equal(f.run().sessionId, sessionId);
  } finally { f.close(); }
});

test('清理本身永久悬挂时有界收尾，同一在途停止调用不重复发送', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  let release!: (stopped: boolean) => void;
  let stops = 0;
  const f = fixture({ stopRequiredProcesses: () => { stops++; return new Promise(resolve => { release = resolve; }); } });
  try {
    await f.start();
    t.mock.timers.tick(10); await flush(); await f.execution.idle();
    assert.equal(f.current().status, 'recovery');
    assert.equal(f.run().stopConfirmed, false);
    const checking = f.execution.reconcileFinalizations(); await flush();
    t.mock.timers.tick(10); await checking;
    assert.equal(stops, 1);
    release(true); await f.execution.reconcileFinalizations();
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.current().status, 'recovery');
  } finally { f.close(); }
});

test('最终状态写入失败时保留停止门禁，存储恢复后只重试结算', async t => {
  t.mock.method(console, 'error', () => {});
  let failedWrites = 0;
  const f = fixture({ stopRequiredProcesses: async () => { failedWrites = 2; return true; } });
  const save = f.store.tasks.save.bind(f.store.tasks);
  f.store.tasks.save = (task, revision) => {
    if (failedWrites > 0) { failedWrites--; throw new Error('注入存储写入失败'); }
    save(task, revision);
  };
  try {
    await f.start(); await f.execution.idle();
    assert.equal(f.run().stopConfirmed, false);
    assert.ok(['waiting', 'recovery'].includes(f.current().status));
    await assert.rejects(f.execution.control(f.task.taskId, { commandId: 'unsafe', revision: f.current().revision, action: 'resume' }), /尚未确认停止/);
    // 恢复存储；停止核对再次执行，但不再注入写入错误。
    f.store.tasks.save = save;
    await f.execution.reconcileFinalizations();
    assert.equal(f.run().stopConfirmed, true);
    assert.equal(f.run().finalizationError, '注入存储写入失败');
    assert.equal(f.current().status, 'recovery');
    assert.equal(f.sends(), 1);
  } finally { f.close(); }
});

for (const stopped of [false, true]) test(`资源停止=${stopped} 时人工请求入口不复活已结束执行`, async () => {
  const f = fixture({ stopRequiredProcesses: async () => stopped });
  const requests = new HumanRequestService({ tasks: f.tasks, runs: f.store.taskRuns, requests: f.store.humanRequests,
    execution: f.execution, events: f.events, assistantEvents: f.stream,
    authorization: { list: () => [], decide: () => { throw new Error('本测试不执行授权决定'); } },
    reviewArtifact: () => { throw new Error('本测试不审核成果'); },
  });
  f.onCommit((task) => requests.afterTaskCommit(task));
  requests.recover();
  try {
    await f.start(); await f.execution.idle();
    assert.equal(f.current().status, stopped ? 'waiting' : 'recovery');
    assert.equal(requests.list(f.task.taskId).filter(request => request.kind === 'recovery').length, stopped ? 0 : 1);
    const reason = f.current().reason;
    const run = f.run();
    const at = new Date().toISOString();
    f.stream.publish({ type: 'assistant.authorization.resolved', cursor: '100', assistantSessionId: run.sessionId, commandId: run.commandId, occurredAt: at,
      data: { request: { requestId: 'late', sessionId: run.sessionId, commandId: run.commandId, toolName: 'read', toolCallId: 'late-tool', targetPath: '/test-only/file', status: 'approved', approval: { scope: 'once' }, createdAt: at, decidedAt: at } },
    } as any);
    assert.equal(f.current().status, stopped ? 'waiting' : 'recovery');
    assert.equal(f.current().reason, reason);
    assert.equal(requests.get('authorization:late').status, 'answered');
  } finally { requests.dispose(); f.close(); }
});

test('收尾故障落盘后重启只核对退出证据，保留原失败并且不重发执行', async t => {
  t.mock.method(console, 'error', () => {});
  const root = await mkdtemp(join(tmpdir(), 'multivac-finalization-'));
  const path = join(root, 'db.sqlite');
  const f = fixture({ stopRequiredProcesses: async () => { throw new Error('依赖停止失败'); } }, path, true);
  const taskId = f.task.taskId;
  let runId: string;
  try {
    await f.start(); await f.execution.idle();
    runId = f.run().runId;
    // 使用不存在的 PID 模拟旧服务真实退出；资源退出另行核对。
    f.tasks.facts(() => f.store.taskRuns.save({ ...f.run(), ownerPid: 99999999 }));
  } finally { f.close(); }
  const store = new SqliteAssistantStore(path);
  let scheduler: TaskScheduler | undefined;
  const tasks: TaskService = new TaskService({ afterCommit: () => scheduler?.wake(), facts: store.taskFacts, requireProject: () => {} });
  let stopped = false;
  let sends = 0;
  const execution = new TaskExecutionService({ settleArtifacts: async () => {}, tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    prepare: async () => { sends++; throw new Error('不得自动重放'); }, createSession: async () => {}, runtime: () => { throw new Error('不得自动创建运行时'); },
    requiredProcessesStopped: () => stopped,
  });
  scheduler = new TaskScheduler(tasks, execution, store.taskRuns, store.taskRuntime).start();
  try {
    assert.equal(tasks.get(taskId).status, 'recovery');
    assert.equal(store.taskRuns.get(runId!)!.stopConfirmed, false);
    assert.equal(store.taskRuns.get(runId!)!.executionError, 'ECONNRESET');
    assert.equal(store.taskRuns.get(runId!)!.cleanupError, '依赖停止失败');
    stopped = true;
    scheduler.reconcileProcessExits(); scheduler.drain();
    assert.equal(store.taskRuns.get(runId!)!.stopConfirmed, true);
    assert.equal(tasks.get(taskId).status, 'recovery');
    assert.equal(sends, 0);
  } finally { scheduler.dispose(); execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
