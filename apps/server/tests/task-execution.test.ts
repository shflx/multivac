import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';
import { TaskWorkingDirectories } from '../src/application/task-working-directories.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

test('准备阶段取消等待真实准备收尾，不创建或发送会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-prepare-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let created = false;
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    prepare: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { directory: { kind: 'task-isolated', path: root }, baseline: null }; },
    createSession: async () => { created = true; }, runtime: () => { throw new Error('尚无会话'); },
  });
  try {
    const task = tasks.create({ commandId: 'c', title: '准备取消', goal: '核对' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' });
    await ready;
    const stop = execution.control(task.taskId, { commandId: 'cancel', revision: tasks.get(task.taskId).revision, action: 'cancel' });
    assert.equal(store.taskRuns.active().length, 1);
    release(); await stop;
    assert.equal(created, false);
    assert.equal(tasks.get(task.taskId).status, 'cancelled');
    assert.equal(store.taskRuns.active().length, 0);
  } finally { execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('任务通过现有命令服务启动、暂停、继续与取消，单轮结束不等于长期目标完成', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-exec-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_COORDINATOR_ADAPTER: 'fake' }, { coordinatorAdapter: adapter });
  try {
    await app.ready;
    let task = app.tasks.create({ commandId: 'create', title: '核对', goal: '在独立目录整理报告' }).task;
    adapter.armPromptCompletionBarrier();
    const command = { commandId: 'start', revision: task.revision, action: 'start' as const };
    const started = await app.taskExecution.control(task.taskId, command);
    await adapter.waitForPromptCompletionBarrierEntry();
    task = app.tasks.get(task.taskId);
    assert.equal(task.status, 'running');
    assert.equal(app.tasks.detail(task.taskId).runs?.length, 1);
    assert.deepEqual(await app.taskExecution.control(task.taskId, command), started);
    assert.equal(app.tasks.detail(task.taskId).runs?.length, 1);
    const firstRun = app.tasks.detail(task.taskId).runs![0]!;
    assert.ok(firstRun.directory?.path.includes('/tasks/'));
    const created = adapter.calls.find((call) => call.method === 'createSession' && call.input.assistantSessionId === firstRun.sessionId);
    assert.ok(created?.method === 'createSession');
    const tools = created.input.internalTools!;
    assert.deepEqual(tools.specs.map((spec) => spec.name).sort(), ['complete_task', 'confirm_human_task', 'get_task', 'list_task_groups', 'list_tasks', 'request_task_input', 'start_managed_process', 'submit_task_result', 'update_task']);
    await writeFile(join(firstRun.directory!.path, 'service.cjs'), 'setInterval(()=>console.log("真实工具启动"),100);');
    const processResult = await tools.invoke({ assistantSessionId: firstRun.sessionId, toolName: 'start_managed_process', toolCallId: 'start-service', args: { name: '任务依赖', script: 'service.cjs', port: null, requiredWhileRunning: true } }, new AbortController().signal);
    assert.equal(processResult.ok, true);
    assert.equal(app.managedProcesses.list().length, 1);
    assert.equal(app.managedProcesses.list()[0]!.state, 'running');
    const query = await tools.invoke({ assistantSessionId: firstRun.sessionId, toolName: 'get_task', toolCallId: 'read-current', args: { taskId: task.taskId } }, new AbortController().signal);
    assert.equal(query.ok, true);
    const changed = await tools.invoke({ assistantSessionId: firstRun.sessionId, toolName: 'update_task', toolCallId: 'change-running-goal', args: { taskId: task.taskId, revision: task.revision, patch: { goal: '替换执行范围' } } }, new AbortController().signal);
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.match(changed.reason, /先安全停止/);
    assert.equal(app.tasks.get(task.taskId).goal, '在独立目录整理报告');
    assert.throws(() => app.tasks.update(task.taskId, { commandId: 'human-during-run', revision: task.revision, patch: { humanOnly: true } }), /安全停止/);
    const pause = app.taskExecution.control(task.taskId, { commandId: 'pause', revision: task.revision, action: 'pause' });
    adapter.releasePromptCompletionBarrier();
    await pause;
    task = app.tasks.get(task.taskId);
    assert.equal(task.status, 'paused');
    assert.equal(app.managedProcesses.list()[0]!.state, 'exited');
    assert.throws(() => app.tasks.update(task.taskId, { commandId: 'human-after-run', revision: task.revision, patch: { humanOnly: true } }), /已有执行记录/);
    assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, true);
    await app.taskExecution.control(task.taskId, { commandId: 'resume', revision: task.revision, action: 'resume' });
    await app.taskExecution.idle();
    task = app.tasks.get(task.taskId);
    assert.equal(task.status, 'waiting');
    assert.equal(task.completedAt, null);
    assert.equal(app.tasks.detail(task.taskId).runs![0]!.status, 'settled');
    assert.equal(task.sessionId, firstRun.sessionId);
    await app.taskExecution.control(task.taskId, { commandId: 'cancel', revision: task.revision, action: 'cancel' });
    assert.equal(app.tasks.get(task.taskId).status, 'cancelled');
    await assert.rejects(app.taskExecution.control(task.taskId, { commandId: 'again', revision: app.tasks.get(task.taskId).revision, action: 'start' }), /终态/);
  } finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('停止不能确认时保留租约，迟到成功不能覆盖取消意图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-stop-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  let release!: (receipt: any) => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(), stopTimeoutMs: 10,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: root }, baseline: null }), createSession: async () => {},
    runtime: () => ({ commands: {
      currentPromptCommandId: () => 'active',
      send: async () => { entered(); return new Promise((resolve) => { release = resolve; }); },
      cancel: async () => { throw new Error('无法确认停止'); },
    } }),
  });
  try {
    const task = tasks.create({ commandId: 'create', title: '停止验证', goal: '核对' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await ready;
    await execution.control(task.taskId, { commandId: 'cancel', revision: tasks.get(task.taskId).revision, action: 'cancel' });
    assert.equal(tasks.get(task.taskId).status, 'recovery');
    assert.equal(store.taskRuns.active().length, 1);
    await assert.rejects(execution.control(task.taskId, { commandId: 'resume', revision: tasks.get(task.taskId).revision, action: 'resume' }), /取消意图/);
    release({ terminalOutcome: 'succeeded', piSessionId: 'pi-session', piEntryId: 'entry' });
    await execution.idle();
    assert.equal(tasks.get(task.taskId).status, 'cancelled');
    assert.equal(tasks.get(task.taskId).completedAt, null);
    assert.equal(store.taskRuns.active().length, 0);
  } finally { execution.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Git 任务从固定 HEAD 创建独占 worktree，保留 dirty 用户工作树', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-git-'));
  const source = join(root, 'source');
  const work = join(root, 'work');
  await mkdir(source); await mkdir(work);
  const git = async (args: string[]) => (await promisify(execFile)('git', ['-C', source, ...args])).stdout.trim();
  try {
    await git(['init']);
    await git(['config', 'user.name', '任务测试']); await git(['config', 'user.email', 'test@example.com']);
    await writeFile(join(source, 'example.txt'), 'baseline'); await git(['add', '.']); await git(['commit', '-m', 'baseline']);
    const baseline = await git(['rev-parse', 'HEAD']);
    await writeFile(join(source, 'example.txt'), 'user-dirty');
    const directories = new TaskWorkingDirectories(work, () => ({ projectId: 'p', name: '项目', directories: [{ kind: 'mounted', path: source }], defaultConstraints: '', createdAt: '' }));
    const result = await directories.prepare({ taskId: 'task', projectId: 'p' } as any, 'run', new AbortController().signal);
    assert.equal(result.baseline, baseline);
    assert.equal(result.directory.kind, 'worktree');
    assert.equal(await readFile(join(result.directory.path, 'example.txt'), 'utf8'), 'baseline');
    assert.equal(await readFile(join(source, 'example.txt'), 'utf8'), 'user-dirty');
    assert.ok((await git(['status', '--porcelain'])).includes('example.txt'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('依赖进程未证明退出时保留 Run 租约，即使模型已返回', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  let checked = false;
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    prepare: async () => ({ directory: { kind: 'task-isolated', path: '/test-only' }, baseline: null }),
    createSession: async () => {}, runtime: () => ({ commands: {
      currentPromptCommandId: () => null,
      send: async () => { throw new Error('模型已结束'); }, cancel: async () => { throw new Error('没有执行'); },
    } }),
    stopRequiredProcesses: async () => { checked = true; return false; },
  });
  try {
    const task = tasks.create({ commandId: 'create', title: '依赖进程', goal: '核对' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await execution.idle();
    assert.equal(checked, true);
    assert.equal(tasks.get(task.taskId).status, 'recovery');
    assert.equal(store.taskRuns.active().length, 1);
  } finally { execution.dispose(); store.close(); }
});

test('暂停停止未确认时，迟到派发事件不得改回运行中', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  const events = new AssistantEventStream();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events, stopTimeoutMs: 5,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: '/test-only' }, baseline: null }), createSession: async () => {},
    runtime: () => ({ commands: { currentPromptCommandId: () => 'active', cancel: async () => { throw new Error('未知'); },
      send: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); throw new Error('已结束'); },
    } }),
  });
  try {
    const task = tasks.create({ commandId: 'create', title: '暂停竞争', goal: '核对' }).task;
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' }); await ready;
    await execution.control(task.taskId, { commandId: 'pause', revision: tasks.get(task.taskId).revision, action: 'pause' });
    const run = store.taskRuns.active()[0]!;
    const before = tasks.get(task.taskId);
    events.publish({ type: 'assistant.command.handed_to_pi', cursor: '100', assistantSessionId: run.sessionId, commandId: run.commandId,
      occurredAt: new Date().toISOString(), data: { dispatchMode: 'prompt' } } as any);
    assert.equal(tasks.get(task.taskId).status, before.status);
    assert.equal(tasks.get(task.taskId).pauseSource, 'user');
    assert.equal(store.taskRuns.get(run.runId)!.stopConfirmed, false);
    release(); await execution.idle();
    assert.equal(tasks.get(task.taskId).status, 'paused');
  } finally { execution.dispose(); store.close(); }
});
