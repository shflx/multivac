import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID, type Task } from '@multivac/contracts';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { TaskService } from '../src/application/task-service.js';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

function tools(store: SqliteAssistantStore, services: Partial<InternalToolServices>) {
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS, services: services as InternalToolServices,
    calls: new SqliteInternalToolCallRepository(store), currentTurn: () => ({ commandId: 'manage-tasks', windowId: 'window' }),
  });
  let sequence = 0;
  const invoke = (toolName: string, args: unknown, toolCallId = `call-${++sequence}`) => service.invoke({
    assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, toolCallId, args,
  }, new AbortController().signal);
  return {
    invoke,
    async ok(toolName: string, args: unknown, toolCallId?: string) {
      const result = await invoke(toolName, args, toolCallId);
      if (!result.ok) assert.fail(result.reason);
      return result;
    },
    async fails(toolName: string, args: unknown, reason: RegExp) {
      const result = await invoke(toolName, args);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, reason);
    },
  };
}

test('删除工具核对版本、停止与反向关系，按关系顺序删除整组，重放及历史保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-delete-tools-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => undefined });
  const tool = tools(store, { taskManagement: tasks, tasks });
  const create = (title: string, fields: Partial<Task> = {}) => tasks.create({ commandId: randomUUID(), title, goal: title, ...fields }).task;
  const args = (task: Task) => ({ taskId: task.taskId, revision: task.revision });
  try {
    const parent = create('父目标');
    const first = create('前置子任务', { parentTaskId: parent.taskId });
    const next = create('后续子任务', { parentTaskId: parent.taskId, dependencyIds: [first.taskId] });
    await tool.fails('delete_task', args(parent), /仍有子任务/);
    await tool.fails('delete_task', args(first), /被其他任务依赖/);
    await tool.ok('update_task', { ...args(next), patch: { title: '已改名' } });
    await tool.fails('delete_task', args(next), /已变化/);
    const latest = args(tasks.get(next.taskId));
    const removed = await tool.ok('delete_task', latest, 'delete-next');
    assert.deepEqual(await tool.ok('delete_task', latest, 'delete-next'), removed);
    assert.deepEqual(removed.result.refs, []);
    await tool.ok('delete_task', args(first));
    await tool.ok('delete_task', args(parent));
    assert.equal(tasks.list().total, 0);
    assert.ok(store.tasks.get(next.taskId)?.deletedAt);
    assert.equal(store.tasks.events(next.taskId)[0]?.kind, 'deleted');

    const running = create('执行中');
    store.tasks.transaction(() => store.tasks.save({ ...running, status: 'running' }, running.revision));
    await tool.fails('delete_task', args(running), /先取消任务/);
    await tool.fails('update_task', { ...args(running), patch: { goal: '改变范围' } }, /先安全停止/);
    assert.equal(tasks.get(running.taskId).goal, running.goal);
    assert.equal(tasks.list().total, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('任务工具贯通分组、预算、执行、澄清、成果读写与验收，权限授权不能走对话入口', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-operations-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  const ledger = new SqliteAssistantStore(join(root, 'tool-ledger.sqlite'));
  const tool = tools(ledger, { taskManagement: app.tasks, tasks: app.tasks, taskControl: app.taskExecution, taskRequestManagement: app.humanRequests, taskArtifactManagement: app.artifacts });
  try {
    await app.ready;
    const grouped = await tool.ok('create_task_group', { title: '报告计划' }, 'group');
    assert.deepEqual(await tool.ok('create_task_group', { title: '报告计划' }, 'group'), grouped);
    const group = app.tasks.groups()[0]!;
    assert.match((await tool.ok('list_task_groups', { projectId: null })).content, /报告计划/);
    assert.equal(app.tasks.groups().length, 1);
    const created = await tool.ok('create_task', { title: '报告', goal: '核对来源', groupId: group.groupId });
    const ref = created.result.refs[0];
    if (ref?.kind !== 'task') assert.fail('缺少任务引用');
    const taskId = ref.taskId;
    const current = () => ({ taskId, revision: app.tasks.get(taskId).revision });
    const budget = { maxRuns: 4, maxMillis: 60000, maxOutputBytes: 1048576 };
    await tool.ok('update_task', { ...current(), patch: { priority: 'high', budget } });
    assert.deepEqual(app.tasks.get(taskId).budget, budget);
    assert.equal(app.tasks.get(taskId).groupId, group.groupId);
    await tool.fails('control_task', { taskId, revision: 99, action: 'start' }, /已变化/);
    await tool.ok('control_task', { ...current(), action: 'start' });
    await app.taskExecution.idle();
    await tool.ok('control_task', { ...current(), action: 'pause' });
    const run = app.tasks.detail(taskId).runs![0]!;
    const question = app.humanRequests.create(taskId, 'clarification', '采用哪个来源？', 'question');
    assert.match((await tool.ok('list_task_requests', { taskId })).content, /采用哪个来源/);
    assert.match((await tool.ok('get_task_request', { requestId: question.requestId })).content, /采用哪个来源/);
    await tool.fails('respond_task_request', { requestId: question.requestId, revision: 99, decision: 'answer', answer: '来源 A' }, /已变化/);
    const answer = { requestId: question.requestId, revision: question.revision, decision: 'answer', answer: '来源 A' };
    const answered = await tool.ok('respond_task_request', answer, 'answer');
    assert.deepEqual(await tool.ok('respond_task_request', answer, 'answer'), answered);
    assert.equal(app.tasks.get(taskId).status, 'paused');
    assert.equal(app.humanRequests.get(question.requestId).answer, '来源 A');

    await tool.fails('submit_task_artifact', { ...current(), runId: 'missing', title: '无执行', text: '内容' }, /真实运行/);
    await tool.ok('submit_task_artifact', { ...current(), runId: run.runId, title: '报告初稿', text: '第一版来源 A' });
    const first = app.artifacts.list(taskId)[0]!;
    assert.match((await tool.ok('list_task_artifacts', { taskId })).content, /报告初稿/);
    const part = await tool.ok('read_task_artifact', { versionId: first.versionId, limit: 3 });
    assert.match(part.content, /下一页 offset：3/);
    assert.ok(part.content.endsWith('第一版'));
    assert.ok((await tool.ok('read_task_artifact', { versionId: first.versionId, offset: 3 })).content.endsWith('来源 A'));
    const review = () => app.humanRequests.list(taskId).find((item) => item.kind === 'review' && item.status === 'pending')!;
    const firstReview = review();
    await tool.fails('respond_task_request', { requestId: firstReview.requestId, revision: firstReview.revision, decision: 'changes' }, /修改意见/);
    await tool.ok('respond_task_request', { requestId: firstReview.requestId, revision: firstReview.revision, decision: 'changes', answer: '补充第二个来源' });
    assert.equal(app.artifacts.get(first.versionId).status, 'changes');
    await tool.ok('submit_task_artifact', { ...current(), runId: run.runId, title: '报告终稿', text: '来源 A 与来源 B' });
    const lastReview = review();
    await tool.fails('respond_task_request', { requestId: firstReview.requestId, revision: firstReview.revision, decision: 'accept' }, /已有不同决定/);
    await tool.ok('respond_task_request', { requestId: lastReview.requestId, revision: lastReview.revision, decision: 'accept' });
    assert.equal(app.tasks.get(taskId).status, 'done');
    await tool.ok('delete_task', current());
    assert.match((await tool.ok('read_task_artifact', { versionId: first.versionId })).content, /第一版来源 A/);

    const authTask = app.tasks.create({ commandId: 'auth-task', title: '授权任务', goal: '边界验证' }).task;
    const authorization = app.humanRequests.create(authTask.taskId, 'authorization', '目录授权', 'auth');
    await tool.fails('respond_task_request', { requestId: authorization.requestId, revision: 1, decision: 'deny' }, /只能由用户在界面/);
    const invalid = await tool.invoke('respond_task_request', { requestId: authorization.requestId, revision: 1, decision: 'once' });
    assert.equal(invalid.ok, false);
    await assert.rejects(app.humanRequests.respond(authorization.requestId, { commandId: 'bypass', revision: 1, decision: 'once' }), /只能由用户在界面/);
    assert.equal(app.humanRequests.get(authorization.requestId).status, 'pending');
    await tool.fails('delete_task', { taskId: authTask.taskId, revision: app.tasks.get(authTask.taskId).revision }, /先取消/);
    await tool.ok('control_task', { taskId: authTask.taskId, revision: app.tasks.get(authTask.taskId).revision, action: 'cancel' });
    await tool.ok('delete_task', { taskId: authTask.taskId, revision: app.tasks.get(authTask.taskId).revision });
    assert.equal(app.tasks.list().total, 0);
  } finally { await app.taskExecution.idle(); app.close(); ledger.close(); await rm(root, { recursive: true, force: true }); }
});
