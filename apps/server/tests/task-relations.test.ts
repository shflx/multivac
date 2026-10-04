import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Check } from 'typebox/value';
import { TaskListSchema, TaskRelationsSchema, UNKNOWN_CHANGE_ORIGIN, type TaskRun } from '@multivac/contracts';
import { TaskService } from '../src/application/task-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { createTaskKind } from '../src/application/proposals/task-proposals.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-relations-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const events = new WorkbenchEvents();
  let count = 0;
  const tasks = new TaskService({ repository: store.tasks, runs: store.taskRuns, events, newId: () => `task-${++count}`, requireProject: () => {} });
  let commands = 0;
  const create = (title: string, parentTaskId: string | null = null, dependencyIds: string[] = []) => tasks.create({ commandId: `create-${++commands}`, title, goal: title, parentTaskId, dependencyIds }).task;
  return { store, tasks, events, create, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('完整直属子任务聚合独立于分页、状态筛选与孙任务，一页不逐卡读取关系', async (t) => {
  const f = await fixture();
  try {
    const parent = f.create('父任务');
    for (let index = 0; index < 110; index++) {
      const child = f.create(`child-${index}`, parent.taskId);
      f.store.tasks.save({ ...child, status: index < 80 ? 'done' : index < 95 ? 'cancelled' : 'idle', ...(index === 109 ? { deletedAt: '2026-10-02' } : {}) }, child.revision);
    }
    const child = f.tasks.list({ parentTaskId: parent.taskId, limit: 1 }).tasks[0]!;
    f.create('孙任务', child.taskId);
    const first = f.tasks.list({ parentTaskId: parent.taskId, limit: 50, includeRelations: true });
    assert.equal(Check(TaskListSchema, first), true);
    assert.equal(first.total, 109); assert.equal(first.nextOffset, 50);
    assert.equal(f.tasks.detail(parent.taskId).children.length, 100);
    const facts = f.tasks.relations(parent.taskId);
    assert.equal(Check(TaskRelationsSchema, facts), true);
    assert.deepEqual(facts.summary.children, { total: 109, done: 80, cancelled: 15 });
    assert.equal(f.tasks.get(parent.taskId).status, 'idle');
    assert.equal(f.tasks.get(parent.taskId).currentRunId, null);
    assert.equal(f.tasks.list({ parentTaskId: parent.taskId, status: 'done', limit: 1 }).total, 80);
    const get = t.mock.method(f.store.tasks, 'get');
    const summaries = t.mock.method(f.store.tasks, 'summaries');
    const listing = f.tasks.list({ limit: 100, includeRelations: true });
    assert.equal(get.mock.callCount(), 0);
    assert.equal(summaries.mock.callCount(), 1);
    assert.equal(Object.keys(listing.relations!).length, 100);
  } finally { await f.close(); }
});

test('关系候选在完整集合分页前排除循环与已选项，保持同项目、日常和深层祖先', async () => {
  const f = await fixture();
  try {
    const root = f.create('根');
    let last = root;
    for (let index = 0; index < 115; index++) last = f.create(`深层-${index}`, last.taskId);
    const outside = f.create('外部同项目');
    f.store.createProject({ projectId: 'project', name: '其他项目', directories: [{ kind: 'mounted', path: '/test-project' }], defaultConstraints: '', createdAt: '' });
    const other = f.tasks.create({ commandId: 'other', title: '跨项目', goal: '核对', projectId: 'project' }).task;
    const candidates = f.tasks.list({ parentCandidateFor: root.taskId, limit: 1 });
    assert.equal(candidates.total, 1); assert.equal(candidates.tasks[0]?.taskId, outside.taskId);
    assert.equal(f.tasks.list({ parentCandidateFor: root.taskId, excludeIds: [outside.taskId] }).total, 0);
    assert.throws(() => f.tasks.list({ parentCandidateFor: root.taskId, projectId: 'project' }), /同一个项目/);
    assert.throws(() => f.tasks.update(root.taskId, { commandId: 'cross', revision: 1, patch: { parentTaskId: other.taskId } }), /跨项目/);
    assert.throws(() => f.tasks.update(root.taskId, { commandId: 'cycle', revision: 1, patch: { parentTaskId: last.taskId } }), /循环/);
    const facts = f.tasks.relations(last.taskId);
    assert.equal(facts.ancestors.length, 100); assert.equal(facts.nextAncestorOffset, 100);
    const next = f.tasks.relations(last.taskId, 100);
    assert.equal(next.ancestors.length, 15); assert.equal(next.ancestors.at(-1)?.taskId, root.taskId); assert.equal(next.nextAncestorOffset, null);
    assert.equal(f.tasks.list({ topLevel: true }).total, 3);
    assert.throws(() => f.tasks.list({ topLevel: true, parentTaskId: root.taskId }), /同时使用/);
    const dep = f.create('后续', null, [outside.taskId]);
    const chained = f.create('后续的后续', null, [dep.taskId]);
    const eligible = f.tasks.list({ dependencyCandidateFor: outside.taskId, query: '后续' });
    assert.equal(eligible.total, 0);
    assert.throws(() => f.tasks.update(outside.taskId, { commandId: 'dep-cycle', revision: 1, patch: { dependencyIds: [chained.taskId] } }), /循环/);
    assert.equal(f.tasks.list({ ids: [root.taskId, other.taskId], limit: 1 }).total, 2);
  } finally { await f.close(); }
});

test('多依赖的审核中和已完成均满足，后续分页完整，关系更新幂等与冲突不重复发布', async () => {
  const f = await fixture();
  try {
    const review = f.create('审核中'); const done = f.create('已完成'); const cancelled = f.create('已取消'); const paused = f.create('暂停'); const failed = f.create('失败');
    for (const [task, status] of [[review, 'review'], [done, 'done'], [cancelled, 'cancelled'], [paused, 'paused'], [failed, 'failed']] as const) f.store.tasks.save({ ...task, status }, 1);
    const parent = f.create('父目标'); const secondParent = f.create('另一父目标');
    const dependent = f.create('多前置', parent.taskId, [review.taskId, done.taskId, cancelled.taskId, paused.taskId, failed.taskId]);
    assert.equal(f.tasks.relations(dependent.taskId).summary.dependencies.done, 2);
    assert.equal(f.tasks.relations(dependent.taskId).summary.dependencies.total, 5);
    for (let index = 0; index < 110; index++) f.create(`后续-${index}`, null, [done.taskId]);
    const ids = new Set<string>();
    let offset: number | null = 0;
    do { const page = f.tasks.list({ dependencyId: done.taskId, offset, limit: 50 }); assert.equal(page.total, 111); page.tasks.forEach((task) => ids.add(task.taskId)); offset = page.nextOffset; } while (offset !== null);
    assert.equal(ids.size, 111);
    let published = 0;
    f.events.subscribe((event) => { if (event.type === 'task.changed') published++; });
    const input = { commandId: 'save', revision: 1, patch: { parentTaskId: secondParent.taskId, dependencyIds: [paused.taskId, done.taskId] } };
    const receipt = f.tasks.update(dependent.taskId, input);
    assert.deepEqual(f.tasks.update(dependent.taskId, { ...input, patch: { ...input.patch, dependencyIds: [done.taskId, paused.taskId] } }), receipt);
    assert.equal(published, 1); assert.equal(f.tasks.relations(parent.taskId).summary.children.total, 0); assert.equal(f.tasks.relations(secondParent.taskId).summary.children.total, 1);
    assert.throws(() => f.tasks.update(dependent.taskId, { ...input, commandId: 'stale' }), { code: 'TASK_CONFLICT' });
    assert.equal(f.store.tasks.command('stale'), null);
    const cleared = f.tasks.update(dependent.taskId, { commandId: 'clear', revision: 2, patch: { parentTaskId: null, dependencyIds: [] } }).task;
    assert.equal(cleared.parentTaskId, null); assert.deepEqual(cleared.dependencyIds, []);
    assert.equal(cleared.status, 'idle'); assert.equal(f.store.taskRuns.active().length, 0);
  } finally { await f.close(); }
});

test('真实停止确认、历史执行树与终态约束共用于关系编辑和提议重新核对', async () => {
  const f = await fixture();
  try {
    const task = f.create('暂停目标'); const before = f.create('前置'); const parent = f.create('父目标');
    f.store.tasks.save({ ...task, status: 'paused' }, 1);
    const run: TaskRun = { runId: 'run', taskId: task.taskId, sessionId: 'session', commandId: 'start', status: 'stopping', stopIntent: 'pause', stopConfirmed: false, ownerId: 'owner', directory: null, baseline: null, projectId: null, scope: '', goal: '', pendingToolIds: [], toolFailures: 0, piSessionId: null, piEntryId: null, reason: '', createdAt: '', updatedAt: '' };
    f.store.taskRuns.save(run);
    assert.match(f.tasks.relations(task.taskId).editReason!, /尚未确认/);
    assert.throws(() => f.tasks.update(task.taskId, { commandId: 'unsafe', revision: 1, patch: { dependencyIds: [before.taskId] } }), /尚未确认/);
    f.store.taskRuns.save({ ...run, stopConfirmed: true, status: 'paused', pendingToolIds: ['tool'] });
    assert.match(f.tasks.relations(task.taskId).editReason!, /工具/);
    f.store.taskRuns.save({ ...run, stopConfirmed: true, status: 'paused' });
    assert.equal(f.tasks.relations(task.taskId).editReason, null);
    assert.match(f.tasks.relations(task.taskId).parentChangeReason!, /共享预算/);
    assert.throws(() => f.tasks.update(task.taskId, { commandId: 'move', revision: 1, patch: { parentTaskId: parent.taskId } }), /共享预算/);
    f.tasks.update(task.taskId, { commandId: 'safe', revision: 1, patch: { dependencyIds: [before.taskId] } });
    const child = f.create('已执行子目标', parent.taskId);
    f.store.taskRuns.save({ ...run, runId: 'child-run', taskId: child.taskId, sessionId: 'child-session', stopConfirmed: true });
    assert.match(f.tasks.relations(parent.taskId).parentChangeReason!, /共享预算/);
    const kind = createTaskKind(f.tasks);
    const payload = { title: '提议子任务', goal: '核对', parentTaskId: parent.taskId, dependencyIds: [before.taskId] };
    const prepared = await kind.prepare(payload);
    f.tasks.update(before.taskId, { commandId: 'change-before', revision: 1, patch: { title: '变化后的前置' } });
    assert.match((await kind.revalidate(payload, prepared.preview, undefined))!, /已变化/);
    const preview = (await kind.prepare(payload)).preview;
    await kind.execute(payload, preview, { ...UNKNOWN_CHANGE_ORIGIN, commandId: 'confirmed' }, undefined);
    await kind.execute(payload, preview, { ...UNKNOWN_CHANGE_ORIGIN, commandId: 'confirmed' }, undefined);
    assert.equal(f.tasks.list({ query: payload.title }).total, 1);
    f.store.tasks.save({ ...f.tasks.get(task.taskId), status: 'done' }, 2);
    assert.match(f.tasks.relations(task.taskId).editReason!, /历史/);
    assert.throws(() => f.tasks.update(task.taskId, { commandId: 'terminal', revision: 2, patch: { dependencyIds: [] } }), /历史/);
  } finally { await f.close(); }
});
