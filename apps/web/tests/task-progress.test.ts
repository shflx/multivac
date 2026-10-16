import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskRelationSummary } from '@multivac/contracts';
import { TasksStore } from '../src/features/tasks/tasks-provider.js';

function task(taskId: string, overrides: Partial<Task> = {}): Task {
  return { taskId, title: taskId, goal: '目标', scope: '', projectId: null, groupId: null, parentTaskId: null,
    dependencyIds: [], priority: 'medium', acceptance: true, acceptanceCriteria: '', revision: 1,
    status: 'idle', sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: '', updatedAt: '', completedAt: null, ...overrides };
}
function summary(total: number, done = 0, cancelled = 0): TaskRelationSummary {
  return { parent: null, children: { total, done, cancelled }, dependencies: { total: 0, done: 0, firstUnmet: null } };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// 与服务端一样直接返回完整统计；测试不从浏览器当前页推算数量。
test('筛选外展开卡片重读完整统计，保留主面板成员与分页，父 revision 不必变化', async (t) => {
  const root = task('root'); const parent = task('parent', { parentTaskId: 'root' });
  const child = task('child', { parentTaskId: 'parent' });
  const records = [root, parent, child]; const calls: URLSearchParams[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const query = new URL(url, 'http://localhost').searchParams; calls.push(query);
    if (!query.has('ids')) return response({ tasks: [root], relations: { root: summary(1) }, total: 800, nextOffset: 100 });
    const selected = records.filter((item) => query.get('ids')!.split(',').includes(item.taskId));
    return response({ tasks: selected, relations: Object.fromEntries(selected.map((item) => [item.taskId, item.taskId === 'parent' ? summary(110, 91, 2) : summary(0)])), total: selected.length, nextOffset: null });
  });
  const store = new TasksStore(); store.setFilter({ query: 'root', viewStatus: 'idle' }); await store.refresh();
  store.cache([parent, child], { parent: summary(110, 90, 2), child: summary(0) });
  const panel = store.snapshot();
  store.apply({ ...child, revision: 2, status: 'done' }, true);
  store.reconcile();
  await store.refreshRelations();
  assert.deepEqual(store.snapshot().relations.parent?.children, { total: 110, done: 91, cancelled: 2 });
  assert.equal(store.snapshot().tasks.find((item) => item.taskId === 'parent')?.revision, 1);
  assert.deepEqual(store.snapshot().panelIds, panel.panelIds);
  assert.equal(store.snapshot().total, 800); assert.equal(store.snapshot().nextOffset, 100);
  const reads = calls.filter((query) => query.has('ids'));
  assert.equal(reads.length, 1); assert.ok(reads[0]!.get('ids')!.split(',').includes('parent'));
  assert.equal(reads[0]!.has('query'), false); assert.equal(reads[0]!.has('viewStatus'), false);
});

test('新增、改父、删除与预读后同版本事件均重读旧新父完整统计', async (t) => {
  const a = task('a'); const b = task('b'); let child = task('child', { parentTaskId: 'a' });
  let facts = { a: summary(1), b: summary(0) };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const ids = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',');
    const tasks = [a, b, ...(!child.deletedAt ? [child] : [])].filter((item) => ids.includes(item.taskId));
    return response({ tasks, relations: facts, total: tasks.length, nextOffset: null });
  });
  const store = new TasksStore(); store.cache([a, b], { a: summary(0), b: summary(0) });
  store.apply(child, true); await store.refreshRelations();
  assert.equal(store.snapshot().relations.a?.children.total, 1);
  child = { ...child, revision: 2, parentTaskId: 'b' };
  // 关系预读先带回新版本，事件到达时已无法从对象缓存找到原父身份。
  store.cache([child]); facts = { a: summary(0), b: summary(1) };
  store.apply(child, true); await store.refreshRelations();
  assert.equal(store.snapshot().relations.a?.children.total, 0);
  assert.equal(store.snapshot().relations.b?.children.total, 1);
  child = { ...child, revision: 3, deletedAt: '2026-10-02' }; facts = { a: summary(0), b: summary(0) };
  store.apply(child, true); await store.refreshRelations();
  assert.equal(store.snapshot().relations.b?.children.total, 0);
  assert.equal(store.snapshot().tasks.some((item) => item.taskId === 'child'), false);
});

test('读取期间再次变更时丢弃旧父统计，重复和乱序事件不使完成数量回退', async (t) => {
  const root = task('root'); let child = task('child', { parentTaskId: 'root', revision: 2, status: 'review' });
  const store = new TasksStore(); store.cache([root, task('child', { parentTaskId: 'root' })], { root: summary(110, 90) });
  let resolve!: (value: Response) => void; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return new Promise<Response>((done) => { resolve = done; });
    return response({ tasks: [root, child], relations: { root: summary(110, 91), child: summary(0) }, total: 2, nextOffset: null });
  });
  store.apply(child, true);
  const pending = store.refreshRelations(); await tick();
  child = { ...child, revision: 3, status: 'done' }; store.apply(child, true);
  assert.equal(store.refreshRelations(), pending);
  resolve(response({ tasks: [root], relations: { root: summary(110, 90) }, total: 1, nextOffset: null }));
  await pending;
  assert.equal(calls, 2); assert.equal(store.snapshot().relations.root?.children.done, 91);
  const version = store.snapshot().relationVersion;
  store.apply(child, true); store.apply({ ...child, revision: 2, status: 'review' }, true);
  await store.refreshRelations();
  assert.equal(calls, 2); assert.equal(store.snapshot().relationVersion, version);
  assert.equal(store.snapshot().relations.root?.children.done, 91);
});

test('统一执行的候选与审核中不计完成，事件突发合并为每批最多一百个身份', async (t) => {
  const parents = Array.from({ length: 205 }, (_, index) => task(`parent-${index}`));
  let child = task('child', { parentTaskId: parents[0]!.taskId, executionTaskId: 'root', executionProgress: 'processing', status: 'waiting' });
  const store = new TasksStore(); store.cache(parents, Object.fromEntries(parents.map((parent) => [parent.taskId, summary(1)])));
  const batches: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const ids = new URL(url, 'http://localhost').searchParams.get('ids')!.split(','); batches.push(ids);
    const selected = [...parents, child].filter((item) => ids.includes(item.taskId));
    return response({ tasks: selected, relations: Object.fromEntries(selected.map((item) => [item.taskId, summary(1, child.status === 'done' ? 1 : 0)])), total: selected.length, nextOffset: null });
  });
  store.apply(child, true);
  child = { ...child, revision: 2, executionProgress: 'ready' }; store.apply(child, true);
  child = { ...child, revision: 3, status: 'review' }; store.apply(child, true);
  const pending = store.refreshRelations(); assert.equal(store.refreshRelations(), pending); await pending;
  assert.deepEqual(batches.map((ids) => ids.length), [100, 100, 6]);
  assert.equal(store.snapshot().relations[parents[0]!.taskId]?.children.done, 0);
  child = { ...child, revision: 4, status: 'done' }; store.apply(child, true); await store.refreshRelations();
  assert.equal(store.snapshot().relations[parents[0]!.taskId]?.children.done, 1);
});

test('两个窗口各自接收事件，重连补齐筛选外父卡片漏掉的状态和关系变化', async (t) => {
  const parent = task('parent'); let child = task('child', { parentTaskId: 'parent' });
  const stores = [new TasksStore(), new TasksStore()];
  let facts = summary(1);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const ids = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',');
    const tasks = [parent, child].filter((item) => ids.includes(item.taskId));
    return response({ tasks, relations: { parent: facts, child: summary(0) }, total: tasks.length, nextOffset: null });
  });
  for (const store of stores) store.cache([parent, child], { parent: facts, child: summary(0) });
  child = { ...child, revision: 2, status: 'done' }; facts = summary(1, 1);
  for (const store of stores) store.apply(child, true);
  await Promise.all(stores.map((store) => store.refreshRelations()));
  for (const store of stores) assert.equal(store.snapshot().relations.parent?.children.done, 1);
  // 断线期间子任务解除父关系，父任务自己的 revision 保持不变。
  child = { ...child, revision: 3, parentTaskId: null }; facts = summary(0);
  for (const store of stores) store.invalidateRelations();
  await Promise.all(stores.map((store) => store.refreshRelations()));
  for (const store of stores) {
    assert.deepEqual(store.snapshot().relations.parent?.children, { total: 0, done: 0, cancelled: 0 });
    assert.equal(store.snapshot().tasks.find((item) => item.taskId === 'child')?.parentTaskId, null);
  }
});

test('统计请求完成与 Promise 收尾之间到达的事件仍被补读', async (t) => {
  const root = task('root'); const child = task('child', { parentTaskId: 'root' });
  const store = new TasksStore(); store.cache([root, child]);
  let calls = 0; let scheduled = false;
  t.mock.method(globalThis, 'fetch', async () => {
    const done = ++calls > 1 ? 1 : 0;
    return response({ tasks: [root], relations: { root: summary(1, done), child: summary(0) }, total: 1, nextOffset: null });
  });
  const unsubscribe = store.subscribe(() => {
    if (scheduled || !store.snapshot().relations.root) return;
    scheduled = true;
    queueMicrotask(() => queueMicrotask(() => {
      store.apply({ ...child, revision: 2, status: 'done' }, true);
      void store.refreshRelations();
    }));
  });
  await store.refreshRelations(); unsubscribe();
  assert.equal(calls, 2); assert.equal(store.snapshot().relations.root?.children.done, 1);
});

test('重连的分页外缓存核对被新事件打断后继续执行，漏掉的删除仍被清除', async (t) => {
  const root = task('root'); const parent = task('parent'); const ghost = task('deleted-offline');
  const store = new TasksStore(); store.cache([root, parent, ghost], { parent: summary(1) });
  let resolve!: (value: Response) => void; let entered!: () => void; let reads = 0;
  const extrasEntered = new Promise<void>((done) => { entered = done; });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const ids = new URL(url, 'http://localhost').searchParams.get('ids');
    if (!ids) return response({ tasks: [root], relations: { root: summary(0) }, total: 1, nextOffset: null });
    if (++reads === 1) { entered(); return new Promise<Response>((done) => { resolve = done; }); }
    const tasks = [root, parent].filter((item) => ids.split(',').includes(item.taskId));
    return response({ tasks, relations: { parent: summary(1, 1) }, total: tasks.length, nextOffset: null });
  });
  store.invalidateRelations(); const pending = store.refresh(false, true); await extrasEntered;
  store.apply(task('child', { parentTaskId: 'parent', status: 'done' }), true);
  resolve(response({ tasks: [parent], relations: { parent: summary(1, 0) }, total: 1, nextOffset: null }));
  await pending; await new Promise<void>((done) => setImmediate(done));
  assert.equal(store.snapshot().tasks.some((item) => item.taskId === ghost.taskId), false);
  assert.equal(store.snapshot().relations.parent?.children.done, 1);
  assert.deepEqual(store.snapshot().panelIds, ['root']); assert.equal(store.snapshot().loading, false);
});

test('统计读取失败保留可重试状态，后续核对恢复正确进度', async (t) => {
  const parent = task('parent'); let fail = true;
  const store = new TasksStore(); store.cache([parent]);
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('离线');
    return response({ tasks: [parent], relations: { parent: summary(3, 2, 1) }, total: 1, nextOffset: null });
  });
  await store.refreshRelations(); assert.equal(store.snapshot().error, '离线');
  fail = false; await store.refreshRelations();
  assert.deepEqual(store.snapshot().relations.parent?.children, { total: 3, done: 2, cancelled: 1 });
});
