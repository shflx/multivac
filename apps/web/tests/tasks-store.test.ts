import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '@multivac/contracts';
import { TasksStore } from '../src/features/tasks/tasks-provider.js';

function task(taskId: string, overrides: Partial<Task> = {}): Task {
  return { taskId, title: taskId, goal: '目标', scope: '', projectId: null, groupId: null, parentTaskId: null,
    dependencyIds: [], priority: 'medium', acceptance: true, acceptanceCriteria: '', revision: 1,
    status: 'idle', sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: '', updatedAt: '', completedAt: null, ...overrides };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('删除推送清除选中，迟到列表、旧回执和重复删除不能使任务重新出现', async (t) => {
  let resolve!: (value: Response) => void;
  const other = task('b');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => ++requests === 1
    ? new Promise<Response>((done) => { resolve = done; })
    : Promise.resolve(response({ tasks: [other], total: 1, nextOffset: null })));
  const store = new TasksStore();
  const original = task('a');
  store.apply(original);
  store.select('a');
  const pending = store.refresh();
  store.apply(task('a', { revision: 2, deletedAt: '2026-10-01T00:00:00Z' }));
  const settled = new Promise<void>((done) => {
    const stop = store.subscribe(() => { if (!store.snapshot().loading) { stop(); done(); } });
  });
  resolve(response({ tasks: [original, other], total: 2, nextOffset: null }));
  await Promise.all([pending, settled]);
  store.apply(original);
  store.apply(task('a', { revision: 2, deletedAt: '2026-10-01T00:00:00Z' }));
  store.select('a');
  assert.deepEqual(store.snapshot().tasks, [other]);
  assert.equal(store.snapshot().selected, null);
  assert.equal(store.snapshot().total, 1);
  assert.equal(requests, 2);
  assert.equal(store.snapshot().loading, false);
});

test('重连补齐错过的删除；分页外的选中对象仍保留', async (t) => {
  let deleted = false;
  const a = task('a');
  const b = task('b');
  t.mock.method(globalThis, 'fetch', async (url: string) => url.includes('?')
    ? response({ tasks: [b], total: deleted ? 1 : 2, nextOffset: deleted ? null : 1 })
    : deleted ? response({ error: { code: 'NOT_FOUND', message: '任务已删除。' } }, 404)
      : response({ task: a, events: [], children: [], totalChildren: 0, nextEventBefore: null }));
  const store = new TasksStore();
  store.apply(a);
  store.select(a.taskId);
  await store.refresh();
  assert.equal(store.snapshot().selected, 'a');
  assert.deepEqual(new Set(store.snapshot().tasks.map((item) => item.taskId)), new Set(['b', 'a']));
  assert.deepEqual(store.snapshot().panelIds, ['b', 'a']);
  deleted = true;
  await store.refresh();
  assert.equal(store.snapshot().selected, null);
  assert.deepEqual(store.snapshot().tasks.map((item) => item.taskId), ['b']);
  assert.equal(store.snapshot().total, 1);
});

test('筛选向服务端传递完整查询，旧响应不覆盖新筛选，其他对象仍在共享缓存', async (t) => {
  const a = task('a');
  const b = task('b', { status: 'failed' });
  const urls: URL[] = [];
  let stale!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url, 'http://localhost'); urls.push(parsed);
    if (!parsed.search) return response({ task: a, events: [], children: [], totalChildren: 0, nextEventBefore: null });
    if (parsed.searchParams.get('query') === '迟到') return new Promise<Response>((done) => { stale = done; });
    return response({ tasks: parsed.searchParams.has('query') ? [b] : [a, b], total: parsed.searchParams.has('query') ? 1 : 2, nextOffset: null });
  });
  const store = new TasksStore();
  await store.refresh();
  store.select('a');
  store.setFilter({ query: '迟到' });
  store.setFilter({ query: 'b', projectId: 'daily', viewStatus: 'waiting' });
  await new Promise<void>((done) => {
    const stop = store.subscribe(() => { if (!store.snapshot().loading) { stop(); done(); } });
  });
  stale(response({ tasks: [a], total: 999, nextOffset: 100 }));
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(store.snapshot().panelIds, ['b']);
  assert.equal(store.snapshot().total, 1);
  assert.equal(store.snapshot().nextOffset, null);
  assert.equal(store.snapshot().selected, null);
  assert.deepEqual(new Set(store.snapshot().tasks.map((task) => task.taskId)), new Set(['a', 'b']));
  const query = urls.find((url) => url.searchParams.get('query') === 'b')!.searchParams;
  assert.equal(query.get('projectId'), 'daily');
  assert.equal(query.get('viewStatus'), 'waiting');
  assert.equal(query.get('offset'), '0');
});

test('加载第二页后实时重读保持已读页，使用服务端排序并保留分页外选中对象', async (t) => {
  const records = Array.from({ length: 200 }, (_, i) => task(`task-${i}`));
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url, 'http://localhost');
    if (!parsed.search) return response({ task: records.at(-1), events: [], children: [], totalChildren: 0, nextEventBefore: null });
    const offset = Number(parsed.searchParams.get('offset'));
    return response({ tasks: records.slice(offset, offset + 100), total: records.length, nextOffset: offset + 100 < records.length ? offset + 100 : null });
  });
  const store = new TasksStore();
  await store.refresh(); await store.refresh(true);
  store.select('task-199');
  records.unshift(task('new'));
  store.apply(records[0]!);
  await store.refresh();
  assert.equal(store.snapshot().panelIds.length, 201);
  assert.equal(store.snapshot().panelIds[0], 'new');
  assert.equal(store.snapshot().panelIds.at(-1), 'task-199');
  assert.equal(store.snapshot().selected, 'task-199');
  assert.equal(store.snapshot().nextOffset, 200);
  assert.equal(store.snapshot().total, 201);
});

test('核对分页外选中对象期间收到的推送，不被先前列表响应覆盖', async (t) => {
  const a = task('a');
  const b = task('b');
  let ready!: () => void;
  let resolve!: (value: Response) => void;
  const entered = new Promise<void>((done) => { ready = done; });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('?')) return response({ tasks: [b], total: 2, nextOffset: 1 });
    ready(); return new Promise<Response>((done) => { resolve = done; });
  });
  const store = new TasksStore();
  store.apply(a); store.select('a');
  const pending = store.refresh();
  await entered;
  store.apply(task('b', { revision: 2, status: 'running', reason: '已经真实开始' }));
  resolve(response({ task: a, events: [], children: [], totalChildren: 0, nextEventBefore: null }));
  await pending;
  const latest = store.snapshot().tasks.find((task) => task.taskId === 'b')!;
  assert.equal(latest.revision, 2);
  assert.equal(latest.status, 'running');
  assert.equal(latest.reason, '已经真实开始');
});

test('重连核对旧选中对象时切到另一任务，不丢失新的选中与详情缓存', async (t) => {
  const a = task('a');
  const b = task('b');
  const c = task('c');
  let ready!: () => void;
  let resolve!: (value: Response) => void;
  const entered = new Promise<void>((done) => { ready = done; });
  const detail = (value: Task) => response({ task: value, events: [], children: [], totalChildren: 0, nextEventBefore: null });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('?')) return response({ tasks: [b], total: 3, nextOffset: 1 });
    if (url.endsWith('/c')) return detail(c);
    ready(); return new Promise<Response>((done) => { resolve = done; });
  });
  const store = new TasksStore();
  store.apply(a); store.apply(c); store.select('a');
  const pending = store.refresh(false, true);
  await entered;
  store.select('c');
  resolve(detail(a));
  await pending;
  assert.equal(store.snapshot().selected, 'c');
  assert.deepEqual(store.snapshot().panelIds, ['b', 'c']);
  assert.deepEqual(new Set(store.snapshot().tasks.map((task) => task.taskId)), new Set(['b', 'c']));
});
