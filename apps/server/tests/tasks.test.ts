import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Check } from 'typebox/value';
import { TaskDetailSchema, TaskListSchema, TaskReceiptSchema, WorkbenchEventSchema } from '@multivac/contracts';
import { TaskService, TaskServiceError } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore, SqliteProjectRepository } from '../src/storage/sqlite-assistant-store.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('任务与回执落盘、分页、关系、版本冲突和无变化事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tasks-'));
  const path = join(root, 'store.sqlite');
  let store = new SqliteAssistantStore(path);
  let count = 0;
  const events = new WorkbenchEvents();
  const published: unknown[] = [];
  events.subscribe((event) => { assert.equal(Check(WorkbenchEventSchema, event), true); published.push(event); });
  const make = () => new TaskService({ repository: store.tasks, requireProject: () => { throw new TaskServiceError('NOT_FOUND', '项目不存在。'); }, events, newId: () => `id-${++count}` });
  let service = make();
  try {
    const group = service.createGroup({ commandId: 'g', title: '研究' });
    const parent = service.create({ commandId: 'a', title: '父目标', goal: '比较来源', groupId: group.groupId }).task;
    const child = service.create({ commandId: 'b', title: '子目标', goal: '核对', parentTaskId: parent.taskId }).task;
    const dependent = service.create({ commandId: 'c', title: '下一步', goal: '汇总', dependencyIds: [child.taskId] }).task;
    assert.equal(parent.status, 'idle');
    assert.equal(parent.currentRunId, null);
    assert.equal(service.list({ limit: 1 }).total, 3);
    assert.equal(service.list({ limit: 1 }).nextOffset, 1);
    assert.equal(service.list({ query: '子目标', projectId: 'daily' }).tasks[0]?.taskId, child.taskId);
    assert.equal(service.list({ dependencyId: child.taskId }).tasks[0]?.taskId, dependent.taskId);
    assert.deepEqual(service.detail(parent.taskId).children, [child.taskId]);
    assert.equal(Check(TaskDetailSchema, service.detail(parent.taskId)), true);
    assert.equal(Check(TaskListSchema, service.list()), true);
    const original = { commandId: 'a', title: '父目标', goal: '比较来源', groupId: group.groupId };
    assert.deepEqual(service.create(original).task, parent);
    assert.equal(published.length, 4);
    assert.throws(() => service.create({ ...original, title: '别的目标' }), { code: 'COMMAND_ID_CONFLICT' });
    assert.throws(() => service.update(parent.taskId, { commandId: 'cycle', revision: 1, patch: { parentTaskId: child.taskId } }), /循环/);
    assert.throws(() => service.update(child.taskId, { commandId: 'cycle-dep', revision: 1, patch: { dependencyIds: [dependent.taskId] } }), /循环/);
    assert.throws(() => service.create({ commandId: 'missing', title: '缺失', goal: '核对', dependencyIds: ['missing'] }), { code: 'NOT_FOUND' });
    assert.throws(() => service.create({ commandId: 'space', title: '  ', goal: '核对' }), /不能为空/);
    const update = { commandId: 'u', revision: 1, patch: { title: '新标题' } };
    const receipt = service.update(parent.taskId, update);
    assert.equal(Check(TaskReceiptSchema, receipt), true);
    assert.equal(receipt.task.revision, 2);
    assert.deepEqual(service.update(parent.taskId, update), receipt);
    assert.throws(() => service.update(parent.taskId, { ...update, commandId: 'stale' }), { code: 'TASK_CONFLICT' });
    assert.equal(service.update(parent.taskId, { commandId: 'noop', revision: 2, patch: { title: '新标题' } }).task.revision, 2);
    assert.equal(published.length, 5);
    assert.equal(service.detail(parent.taskId).events.length, 2);
    assert.equal(service.detail(parent.taskId).events[1]?.task.title, '父目标');
    store.close();
    store = new SqliteAssistantStore(path);
    service = make();
    assert.deepEqual(service.get(parent.taskId), receipt.task);
    assert.deepEqual(service.create(original).task, parent);
    assert.equal(service.groups()[0]?.groupId, group.groupId);
    assert.deepEqual(service.get(dependent.taskId).dependencyIds, [child.taskId]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('进展分页引用对应命令的历史版本，不以当前标题覆写过去', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-events-'));
  const store = new SqliteAssistantStore(join(root, 'store.sqlite'));
  const service = new TaskService({ repository: store.tasks, requireProject: () => {} });
  try {
    let task = service.create({ commandId: 'create', title: '原始标题', goal: '核对' }).task;
    for (let i = 0; i < 105; i++) {
      task = service.update(task.taskId, { commandId: `update-${i}`, revision: task.revision, patch: { title: `版本 ${i}` } }).task;
    }
    const first = service.detail(task.taskId);
    assert.equal(first.events.length, 100);
    assert.ok(first.nextEventBefore);
    const second = service.detail(task.taskId, first.nextEventBefore);
    assert.equal(second.events.length, 6);
    assert.equal(second.nextEventBefore, null);
    assert.equal(second.events[5]?.task.title, '原始标题');
    assert.equal(first.events[0]?.task.revision, 106);
    assert.equal(new Set([...first.events, ...second.events].map((event) => event.eventId)).size, 106);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('关系换项目与执行边界不能绕过服务校验，事务失败不残留事件或回执', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-scope-'));
  const store = new SqliteAssistantStore(join(root, 'store.sqlite'));
  const projects = new SqliteProjectRepository(store);
  const service = new TaskService({ repository: store.tasks, requireProject: (id) => assert.ok(projects.get(id)) });
  try {
    projects.create({ projectId: 'p', name: '项目', directories: [{ kind: 'managed', path: root }], defaultConstraints: '', createdAt: new Date().toISOString() });
    const daily = service.create({ commandId: 'daily', title: '日常', goal: '整理' }).task;
    const project = service.create({ commandId: 'project', title: '项目任务', goal: '核对', projectId: 'p' }).task;
    assert.throws(() => service.update(daily.taskId, { commandId: 'cross', revision: 1, patch: { dependencyIds: [project.taskId] } }), /跨项目/);
    const child = service.create({ commandId: 'child', title: '子目标', goal: '整理', parentTaskId: daily.taskId }).task;
    assert.throws(() => service.update(daily.taskId, { commandId: 'move', revision: 1, patch: { projectId: 'p' } }), /原范围/);
    assert.equal(store.tasks.command('move'), null);
    assert.equal(service.detail(daily.taskId).events.length, 1);
    store.tasks.transaction(() => store.tasks.save({ ...child, status: 'running' }, 1));
    assert.throws(() => service.update(child.taskId, { commandId: 'active', revision: 1, patch: { scope: '扩大范围' } }), /安全停止/);
    store.tasks.transaction(() => store.tasks.save({ ...daily, status: 'done' }, 1));
    assert.throws(() => service.update(daily.taskId, { commandId: 'terminal', revision: 1, patch: { title: '覆盖历史' } }), /历史/);
    assert.throws(() => store.tasks.transaction(() => { store.tasks.save({ ...project, title: '不应落盘' }, 1); throw new Error('失败'); }), /失败/);
    assert.equal(service.get(project.taskId).title, '项目任务');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('任务 HTTP 使用真实持久化、严格查询及 revision，重启保留事实', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-http-'));
  let app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  const start = async () => {
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  const stop = async () => { await new Promise<void>((resolve) => app.server.close(() => resolve())); app.close(); };
  try {
    let base = await start();
    const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'http', title: '真实任务', goal: '核对数据' }) });
    assert.equal(response.status, 200);
    const created = await response.json() as { task: { taskId: string } };
    assert.equal((await fetch(`${base}/api/tasks?limit=1`)).status, 200);
    for (const query of ['limit=101', 'offset=-1', 'status=made-up', 'viewStatus=made-up', 'query=a&query=b', '__proto__=x']) assert.equal((await fetch(`${base}/api/tasks?${query}`)).status, 400);
    assert.equal((await fetch(`${base}/api/tasks/${created.task.taskId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'stale', revision: 9, patch: { title: '错误版本' } }) })).status, 409);
    assert.equal((await fetch(`${base}/api/tasks/missing`)).status, 404);
    for (const query of ['limit=101', 'offset=-1', 'status=made-up', 'limit=1&limit=2', '__proto__=x']) assert.equal((await fetch(`${base}/api/task-requests?${query}`)).status, 400);
    assert.equal((await fetch(`${base}/api/tasks/${created.task.taskId}/requests?unknown=1`)).status, 400);
    for (const path of ['task-requests/missing/decision', `tasks/${created.task.taskId}/artifacts`]) {
      assert.equal((await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(128 * 1024 + 1) })).status, 413);
    }
    await stop();
    app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
    base = await start();
    const restored = await (await fetch(`${base}/api/tasks/${created.task.taskId}`)).json();
    assert.equal(Check(TaskDetailSchema, restored), true);
    const deleteBody = JSON.stringify({ commandId: 'delete-http', revision: 1 });
    const remove = () => fetch(`${base}/api/tasks/${created.task.taskId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: deleteBody });
    assert.equal((await fetch(`${base}/api/tasks/${created.task.taskId}?query=bad`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: deleteBody })).status, 400);
    const deleted = await remove();
    assert.equal(deleted.status, 200);
    const receipt = await deleted.json();
    assert.equal(Check(TaskReceiptSchema, receipt), true);
    assert.deepEqual(await (await remove()).json(), receipt);
    assert.equal((await fetch(`${base}/api/tasks/${created.task.taskId}`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/tasks`)).json() as { total: number }).total, 0);
  } finally { await stop(); await rm(root, { recursive: true, force: true }); }
});

test('已有 SQLite 基线追加任务迁移后仍可重开，迁移版本不重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-migration-'));
  const path = join(root, 'store.sqlite');
  try {
    new SqliteAssistantStore(path).close();
    const db = new DatabaseSync(path);
    const count = (db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n;
    db.close();
    new SqliteAssistantStore(path).close();
    const reopened = new DatabaseSync(path);
    assert.equal((reopened.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, count);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
