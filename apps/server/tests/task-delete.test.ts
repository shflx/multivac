import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TaskRun } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

test('删除落盘并隐藏查询，命令重放不重复发布，历史引用保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-delete-'));
  const path = join(root, 'db.sqlite');
  let store = new SqliteAssistantStore(path);
  const events = new WorkbenchEvents();
  let deletes = 0;
  events.subscribe((event) => { if (event.type === 'task.changed' && event.task.deletedAt) deletes++; });
  const make = () => new TaskService({ repository: store.tasks, requireProject: () => {}, events });
  let service = make();
  try {
    const task = service.create({ commandId: 'create', title: '删除测试', goal: '保留历史' }).task;
    const input = { commandId: 'delete', revision: task.revision };
    assert.throws(() => service.remove(task.taskId, { ...input, commandId: 'stale', revision: 9 }), { code: 'TASK_CONFLICT' });
    assert.equal(store.tasks.command('stale'), null);
    const receipt = service.remove(task.taskId, input);
    assert.ok(receipt.task.deletedAt);
    assert.equal(receipt.task.revision, task.revision + 1);
    assert.deepEqual(service.remove(task.taskId, input), receipt);
    assert.equal(deletes, 1);
    assert.throws(() => service.remove(task.taskId, { ...input, revision: 2 }), { code: 'COMMAND_ID_CONFLICT' });
    assert.throws(() => service.get(task.taskId), { code: 'NOT_FOUND' });
    assert.equal(service.list({ query: '删除测试' }).total, 0);
    assert.equal(store.tasks.events(task.taskId)[1]?.task.title, '删除测试');
    assert.equal(store.tasks.events(task.taskId)[0]?.kind, 'deleted');
    assert.throws(() => service.update(task.taskId, { commandId: 'update', revision: 2, patch: { title: '恢复' } }), { code: 'NOT_FOUND' });
    store.close();
    store = new SqliteAssistantStore(path);
    service = make();
    assert.equal(service.list().total, 0);
    assert.throws(() => service.detail(task.taskId), { code: 'NOT_FOUND' });
    assert.deepEqual(service.remove(task.taskId, input), receipt);
    assert.equal(deletes, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('删除不能绕过执行停止与任务关系；删除失败不留下回执和事件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-delete-boundaries-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const service = new TaskService({ repository: store.tasks, runs: store.taskRuns, requireProject: () => {} });
  try {
    const parent = service.create({ commandId: 'parent', title: '父任务', goal: '核对' }).task;
    const child = service.create({ commandId: 'child', title: '子任务', goal: '核对', parentTaskId: parent.taskId }).task;
    const dependent = service.create({ commandId: 'dep', title: '依赖任务', goal: '核对', dependencyIds: [child.taskId] }).task;
    assert.throws(() => service.remove(parent.taskId, { commandId: 'parent-delete', revision: 1 }), /子任务/);
    assert.throws(() => service.remove(child.taskId, { commandId: 'child-delete', revision: 1 }), /依赖/);
    assert.equal(store.tasks.command('parent-delete'), null);
    assert.equal(store.tasks.events(parent.taskId).length, 1);
    service.remove(dependent.taskId, { commandId: 'dep-delete', revision: 1 });
    service.remove(child.taskId, { commandId: 'child-delete', revision: 1 });
    service.remove(parent.taskId, { commandId: 'parent-delete', revision: 1 });
    const active = service.create({ commandId: 'active', title: '执行任务', goal: '核对' }).task;
    store.tasks.transaction(() => store.tasks.save({ ...active, status: 'running' }, 1));
    assert.throws(() => service.remove(active.taskId, { commandId: 'active-delete', revision: 1 }), /先取消/);
    store.tasks.transaction(() => store.tasks.save({ ...active, status: 'cancelled' }, 1));
    const run: TaskRun = {
      runId: 'lease', taskId: active.taskId, sessionId: 'task-session', commandId: 'start', status: 'stopping',
      stopIntent: 'cancel', stopConfirmed: false, ownerId: 'owner', directory: null, baseline: null,
      projectId: null, scope: '', goal: '核对', pendingToolIds: [], toolFailures: 0,
      piSessionId: null, piEntryId: null, reason: '等待停止', createdAt: '', updatedAt: '',
    };
    store.taskRuns.save(run);
    assert.throws(() => service.remove(active.taskId, { commandId: 'lease-delete', revision: 1 }), /停止尚未确认/);
    assert.equal(store.tasks.command('lease-delete'), null);
    store.taskRuns.save({ ...run, stopConfirmed: true, status: 'cancelled' });
    service.remove(active.taskId, { commandId: 'lease-delete', revision: 1 });
    assert.equal(store.taskRuns.bySession('task-session')?.runId, run.runId);
    assert.equal(service.list().total, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
