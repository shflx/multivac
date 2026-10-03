import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskRelationSummary } from '@multivac/contracts';
import { TasksStore } from '../src/features/tasks/tasks-provider.js';
import { TaskRelationQuery } from '../src/features/tasks/task-relation-queries.js';
import { taskTreeRows } from '../src/features/tasks/task-tree-state.js';

function task(taskId: string, overrides: Partial<Task> = {}): Task {
  return { taskId, title: taskId, goal: '目标', scope: '', projectId: null, groupId: null, parentTaskId: null, dependencyIds: [], priority: 'medium', acceptance: true, acceptanceCriteria: '', revision: 1, status: 'idle', sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: '', updatedAt: '', completedAt: null, ...overrides };
}
const summary: TaskRelationSummary = { parent: null, children: { total: 110, done: 90, cancelled: 2 }, dependencies: { total: 0, done: 0, firstUnmet: null } };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('关系分页共享对象与完整统计，不改变主面板成员、数量、分页与筛选', async (t) => {
  const main = task('main');
  const children = Array.from({ length: 110 }, (_, index) => task(`child-${index}`, { parentTaskId: main.taskId }));
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const query = new URL(url, 'http://localhost').searchParams;
    if (!query.has('parentTaskId')) return response({ tasks: [main], relations: { main: summary }, total: 800, nextOffset: 100 });
    const offset = Number(query.get('offset'));
    return response({ tasks: children.slice(offset, offset + 50), total: 110, nextOffset: offset + 50 < 110 ? offset + 50 : null });
  });
  const store = new TasksStore();
  store.setFilter({ query: 'main', projectId: 'daily' });
  await store.refresh();
  const panel = store.snapshot();
  const query = new TaskRelationQuery(store, { parentTaskId: 'main' });
  await query.refresh(); await query.refresh(true); await query.refresh(true);
  assert.equal(query.snapshot().ids.length, 110); assert.equal(query.snapshot().total, 110); assert.equal(query.snapshot().nextOffset, null);
  assert.deepEqual(store.snapshot().panelIds, panel.panelIds); assert.equal(store.snapshot().total, 800); assert.equal(store.snapshot().nextOffset, 100);
  assert.equal(store.snapshot().tasks.length, 111);
  assert.deepEqual(store.snapshot().relations.main?.children, summary.children);
  await query.refresh(); assert.equal(query.snapshot().ids.length, 110);
});

test('过期关系查询只合并较新对象，删除墓碑与主查询不被迟到响应覆盖', async (t) => {
  const store = new TasksStore(); const parent = task('parent'); const child = task('child', { parentTaskId: 'parent' });
  store.apply(parent); store.apply(child); store.select('parent');
  let resolve!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((done) => { resolve = done; }));
  const reader = new TaskRelationQuery(store, { parentTaskId: 'parent' });
  const pending = reader.refresh(); reader.dispose();
  store.apply({ ...child, status: 'done', revision: 3 });
  store.apply({ ...parent, deletedAt: '2026-10-02', revision: 2 });
  resolve(response({ tasks: [parent, child], total: 2, nextOffset: null, relations: { parent: summary } }));
  await pending;
  assert.equal(store.snapshot().tasks.some((task) => task.taskId === 'parent'), false);
  assert.equal(store.snapshot().tasks.find((task) => task.taskId === 'child')?.revision, 3);
  assert.equal(store.snapshot().selected, null);
  assert.deepEqual(reader.snapshot().ids, []);
  assert.equal(store.snapshot().relations.parent, undefined);
});

test('子任务变更使旧、新父进度失效，缓存预读后同版本事件仍刷新关系', () => {
  const store = new TasksStore(); const a = task('a'); const b = task('b'); const child = task('child', { parentTaskId: 'a' });
  store.cache([a, b, child], { a: summary, b: summary });
  const version = store.snapshot().relationVersion;
  store.apply({ ...child, parentTaskId: 'b', revision: 2 }, true);
  assert.equal(store.snapshot().relations.a, undefined); assert.equal(store.snapshot().relations.b, undefined);
  assert.equal(store.snapshot().relationVersion, version + 1);
  store.cache([{ ...child, parentTaskId: 'b', revision: 3 }], { b: summary });
  store.apply({ ...child, parentTaskId: 'b', revision: 3 }, true);
  assert.equal(store.snapshot().relations.b, undefined);
  assert.equal(store.snapshot().relationVersion, version + 2);
});

test('列表展开按稳定身份去重，不丢深层子任务，筛选外关系明确作为上下文', () => {
  const tasks = [task('root'), ...Array.from({ length: 120 }, (_, index) => task(`node-${index}`, { parentTaskId: index ? `node-${index - 1}` : 'root' }))];
  const cache = new Map(tasks.map((task) => [task.taskId, task]));
  const expanded = new Set(tasks.map((task) => task.taskId));
  const children = new Map(tasks.slice(1).map((task) => [task.parentTaskId!, [task.taskId]]));
  const rows = taskTreeRows(['node-60', 'root'], cache, expanded, children);
  assert.equal(rows.length, 121); assert.equal(new Set(rows.map((row) => row.id)).size, 121);
  assert.equal(rows.find((row) => row.id === 'node-119')?.depth, 120);
  assert.equal(rows.find((row) => row.id === 'node-60')?.context, false);
  assert.equal(rows.find((row) => row.id === 'node-61')?.context, true);
  const filtered = taskTreeRows(['node-60'], cache, new Set(), children);
  assert.deepEqual(filtered, [{ id: 'node-60', depth: 0, context: false }]);
  cache.set('node-10', { ...cache.get('node-10')!, parentTaskId: null });
  const moved = taskTreeRows(['root', 'node-10'], cache, expanded, children);
  assert.equal(moved.filter((row) => row.id === 'node-10').length, 1); assert.equal(moved.find((row) => row.id === 'node-10')?.depth, 0);
});

test('同一事件水位的迟到查询不覆盖较新聚合与更高版本对象，空排除集合不发送无效参数', async (t) => {
  const store = new TasksStore(); const root = task('root'); store.apply(root);
  let resolve!: (value: Response) => void;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (url: string) => {
    assert.equal(new URL(url, 'http://localhost').searchParams.has('excludeIds'), false);
    if (++calls === 1) return new Promise<Response>((done) => { resolve = done; });
    return Promise.resolve(response({ tasks: [{ ...root, revision: 2 }], relations: { root: { ...summary, children: { total: 110, done: 100, cancelled: 2 } } }, total: 1, nextOffset: null }));
  });
  const old = store.query({ ids: ['root'], excludeIds: [] });
  await store.query({ ids: ['root'], excludeIds: [] });
  resolve(response({ tasks: [root], relations: { root: summary }, total: 1, nextOffset: null })); await old;
  assert.equal(store.snapshot().tasks[0]?.revision, 2); assert.equal(store.snapshot().relations.root?.children.done, 100);
  assert.deepEqual(store.snapshot().panelIds, ['root']); assert.equal(store.snapshot().total, 1);
});

test('显式打开关系对象的迟到详情不夺回新对象或已关闭的选择', async (t) => {
  const store = new TasksStore();
  const replies = new Map<string, (value: Response) => void>();
  t.mock.method(globalThis, 'fetch', (url: string) => new Promise<Response>((done) => { replies.set(url, done); }));
  const first = store.open('first'); const second = store.open('second');
  const detail = (taskId: string) => ({ task: task(taskId), events: [], children: [], totalChildren: 0, nextEventBefore: null });
  replies.get('/api/tasks/second')!(response(detail('second'))); await second;
  replies.get('/api/tasks/first')!(response(detail('first'))); await first;
  assert.equal(store.snapshot().selected, 'second');
  const third = store.open('third'); store.select(null);
  replies.get('/api/tasks/third')!(response(detail('third'))); await third;
  assert.equal(store.snapshot().selected, null);
});
