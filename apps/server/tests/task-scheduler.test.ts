import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/application/task-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskScheduler } from '../src/application/task-scheduler.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-scheduler-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const events = new WorkbenchEvents();
  const stream = new AssistantEventStream();
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {}, events });
  const launches: string[] = [];
  let cursor = 0;
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: stream,
    prepare: async (task) => { launches.push(task.taskId); return { directory: { kind: 'task-isolated', path: join(root, task.taskId) }, baseline: null }; },
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null,
      cancel: async () => { throw new Error('没有正在运行的模型'); },
      send: async (command) => {
        stream.publish({ cursor: String(++cursor), eventId: `e${cursor}`, assistantSessionId: command.assistantSessionId, commandId: command.commandId, type: 'assistant.command.handed_to_pi', data: { kind: 'send', dispatchMode: 'prompt' }, occurredAt: new Date().toISOString() });
        return { commandId: command.commandId, assistantSessionId: command.assistantSessionId, kind: 'send', status: 'terminal', terminalOutcome: 'succeeded', error: null, piSessionId: 'pi', piEntryId: 'entry', piTurnRef: null, createdAt: '', updatedAt: '' };
      },
    } }),
  });
  const scheduler = new TaskScheduler(tasks, execution, store.taskRuns, store.taskRuntime, events);
  return { root, store, tasks, execution, scheduler, launches, async close() { await execution.idle(); scheduler.dispose(); execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('确定性优先级、依赖与共享预算，不以呈现列数限制并行', async () => {
  const f = await fixture();
  try {
    const low = f.tasks.create({ commandId: 'low', title: '低', goal: '核对', priority: 'low' }).task;
    const high = f.tasks.create({ commandId: 'high', title: '高', goal: '核对', priority: 'high' }).task;
    await Promise.all([f.execution.control(low.taskId, { commandId: 'sl', revision: 1, action: 'start' }), f.execution.control(high.taskId, { commandId: 'sh', revision: 1, action: 'start' })]);
    await f.execution.idle();
    assert.deepEqual(f.launches, [high.taskId, low.taskId]);
    const dependent = f.tasks.create({ commandId: 'dep', title: '依赖', goal: '核对', dependencyIds: [high.taskId] }).task;
    await f.execution.control(dependent.taskId, { commandId: 'sd', revision: 1, action: 'start' });
    await f.execution.idle();
    assert.equal(f.tasks.get(dependent.taskId).status, 'queued');
    assert.match(f.tasks.get(dependent.taskId).reason, /前置/);
    f.tasks.transition(high.taskId, { commandId: 'verified', key: 'verified', kind: 'verified', summary: '测试中由验证用例完成前置。' }, (task) => ({ ...task, status: 'done', completedAt: new Date().toISOString() }));
    await Promise.resolve(); await f.execution.idle();
    assert.equal(f.tasks.get(dependent.taskId).status, 'waiting');
    const parent = f.tasks.create({ commandId: 'budget', title: '预算', goal: '核对', budget: { maxRuns: 1, maxMillis: 900000, maxOutputBytes: 4096 } }).task;
    const child = f.tasks.create({ commandId: 'child', title: '子任务', goal: '核对', parentTaskId: parent.taskId }).task;
    await f.execution.control(child.taskId, { commandId: 'sc', revision: 1, action: 'start' }); await f.execution.idle();
    await f.execution.control(parent.taskId, { commandId: 'sp', revision: 1, action: 'start' }); await f.execution.idle();
    assert.equal(f.tasks.get(parent.taskId).status, 'queued');
    assert.match(f.tasks.get(parent.taskId).reason, /预算/);
    await assert.rejects(Promise.resolve().then(() => f.tasks.update(child.taskId, { commandId: 'move', revision: f.tasks.get(child.taskId).revision, patch: { parentTaskId: null } })), /共享预算/);
  } finally { await f.close(); }
});

test('用户暂停与前置取消不会自动恢复或满足依赖，排队取消不创建运行', async () => {
  const f = await fixture();
  try {
    const before = f.tasks.create({ commandId: 'before', title: '前置', goal: '核对' }).task;
    const task = f.tasks.create({ commandId: 'after', title: '后续', goal: '核对', dependencyIds: [before.taskId] }).task;
    await f.execution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' });
    await f.execution.control(task.taskId, { commandId: 'pause', revision: f.tasks.get(task.taskId).revision, action: 'pause' });
    f.scheduler.drain();
    assert.equal(f.tasks.get(task.taskId).status, 'paused');
    assert.equal(f.launches.length, 0);
    await f.execution.control(before.taskId, { commandId: 'cancel-before', revision: 1, action: 'cancel' });
    await f.execution.control(task.taskId, { commandId: 'resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' });
    f.scheduler.drain();
    assert.match(f.tasks.get(task.taskId).reason, /cancelled/);
    await f.execution.control(task.taskId, { commandId: 'cancel', revision: f.tasks.get(task.taskId).revision, action: 'cancel' });
    assert.equal(f.tasks.get(task.taskId).status, 'cancelled');
    assert.equal(f.store.taskRuns.active().length, 0);
  } finally { await f.close(); }
});

test('单实例所有权与工具租约失效时阻止副作用', async () => {
  const f = await fixture();
  try {
    assert.throws(() => new TaskScheduler(f.tasks, new TaskExecutionService({ tasks: f.tasks, runs: f.store.taskRuns, events: new AssistantEventStream(), prepare: async () => { throw new Error(); }, createSession: async () => {}, runtime: () => { throw new Error(); } }), f.store.taskRuns, f.store.taskRuntime, new WorkbenchEvents()), /调度权/);
    f.tasks.facts(() => f.store.taskRuntime.claim('another-owner', process.pid));
    await assert.rejects(f.execution.control(f.tasks.create({ commandId: 'c', title: '租约', goal: '核对' }).task.taskId, { commandId: 's', revision: 1, action: 'start' }), /租约/);
  } finally { await f.close(); }
});

test('重启不重放结果不明的执行，保留目录租约与恢复状态', async () => {
  const f = await fixture();
  let second: TaskScheduler | undefined;
  let execution: TaskExecutionService | undefined;
  try {
    const dependency = f.tasks.create({ commandId: 'dependency', title: '前置', goal: '核对' }).task;
    const task = f.tasks.create({ commandId: 'old', title: '旧执行', goal: '核对', dependencyIds: [dependency.taskId] }).task;
    await f.execution.control(task.taskId, { commandId: 'start-old', revision: 1, action: 'start' });
    f.scheduler.dispose(); f.execution.dispose();
    const run = f.store.taskRuns.get(f.tasks.get(task.taskId).currentRunId!)!;
    f.tasks.facts(() => f.store.taskRuns.save({ ...run, hasStarted: true, ownerPid: 99999999, nativePendingIds: ['unconfirmed-tool'], directory: { kind: 'task-isolated', path: join(f.root, 'old-directory') } }));
    execution = new TaskExecutionService({ tasks: f.tasks, runs: f.store.taskRuns, events: new AssistantEventStream(), prepare: async () => { throw new Error('不得重放'); }, createSession: async () => { throw new Error('不得重放'); }, runtime: () => { throw new Error('不得重放'); } });
    second = new TaskScheduler(f.tasks, execution, f.store.taskRuns, f.store.taskRuntime, new WorkbenchEvents());
    second.drain();
    assert.equal(f.tasks.get(task.taskId).status, 'recovery');
    assert.equal(f.store.taskRuns.get(run.runId)?.stopConfirmed, false);
    assert.equal(f.store.taskRuns.active().length, 1);
    await assert.rejects(execution.control(task.taskId, { commandId: 'unsafe-resume', revision: f.tasks.get(task.taskId).revision, action: 'resume' }), /未确认停止/);
    assert.equal(f.launches.length, 0);
  } finally { second?.dispose(); execution?.dispose(); await f.close(); }
});
