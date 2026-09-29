import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Workspace } from '@multivac/contracts';
import { Workspaces, workspaceName, workspaceSummary } from '../src/features/workspace/workspaces.js';

function project(projectId: string, directories: Project['directories']): Project {
  return {
    projectId, name: projectId, directories, defaultConstraints: '',
    createdAt: '2026-09-28T08:00:00.000Z', updatedAt: '2026-09-28T08:00:00.000Z',
  };
}

const research: Workspace = {
  workspaceId: 'research', name: '技术研究',
  project: project('research', [{ kind: 'managed', path: '/Users/me/Multivac/projects/技术研究' }]),
};
const code: Workspace = {
  workspaceId: 'code', name: 'Multivac 开发',
  project: project('code', [
    { kind: 'mounted', path: '/Users/me/code/multivac' },
    { kind: 'mounted', path: '/Users/me/code/docs' },
  ]),
};
const fallback: Workspace = { workspaceId: 'default', name: '默认工作区', project: null };

test('工作区列表只读取一次，失败后可重读；新建项目的工作区排在默认工作区之前', async () => {
  let calls = 0;
  const results: Array<() => Promise<readonly Workspace[]>> = [
    () => Promise.reject(new Error('网络错误')),
    () => Promise.resolve([research, fallback]),
  ];
  const store = new Workspaces(() => results[calls++]!());
  let published = 0;
  store.subscribe(() => { published += 1; });

  await assert.rejects(store.ensureLoaded(), /网络错误/u);
  assert.equal(store.snapshot(), null);
  const [first, second] = await Promise.all([store.ensureLoaded(), store.ensureLoaded()]);
  assert.equal(calls, 2);
  assert.equal(first, second);
  assert.deepEqual(store.snapshot(), [research, fallback]);
  assert.equal(await store.ensureLoaded(), first);
  assert.equal(calls, 2);

  store.upsert(code);
  assert.deepEqual(store.snapshot()?.map((item) => item.workspaceId), ['research', 'code', 'default']);
  store.upsert({ ...research, name: '研究（改名）' });
  assert.deepEqual(store.snapshot()?.map((item) => item.name), ['研究（改名）', 'Multivac 开发', '默认工作区']);
  assert.equal(published, 3);
});

test('读取完成前写回的工作区不被较早的读取结果覆盖', async () => {
  let resolve!: (value: readonly Workspace[]) => void;
  const store = new Workspaces(() => new Promise((onResolve) => { resolve = onResolve; }));
  store.upsert({ ...research, name: '研究（新）' });
  const loading = store.ensureLoaded();
  store.upsert(code);
  assert.equal(store.snapshot(), null);
  resolve([research, fallback]);
  await loading;
  assert.deepEqual(store.snapshot()?.map((item) => item.name), ['研究（新）', 'Multivac 开发', '默认工作区']);
});

test('工作区名称与目录摘要', () => {
  assert.equal(workspaceName([research, fallback], 'research'), '技术研究');
  assert.equal(workspaceName(null, 'default'), '默认工作区');
  assert.equal(workspaceName([fallback], 'missing'), 'missing');
  assert.equal(workspaceSummary(research), '项目托管目录 · /Users/me/Multivac/projects/技术研究');
  assert.equal(workspaceSummary(code), '挂载目录 · /Users/me/code/multivac 等 2 个目录');
  assert.equal(workspaceSummary(fallback), '不属于项目 · 各会话使用临时目录');
});

test('整体重读（事件流重连后）：从未读取时不读；重读期间推送来的工作区以推送为准；读取失败保留列表', async () => {
  const pending: Array<(value: readonly Workspace[]) => void> = [];
  const failures: boolean[] = [];
  const store = new Workspaces(() => {
    if (failures.shift()) return Promise.reject(new Error('网络错误'));
    return new Promise((resolve) => { pending.push(resolve); });
  });
  await store.refresh();
  assert.equal(pending.length, 0);

  const loading = store.ensureLoaded();
  pending.shift()!([fallback]);
  await loading;

  const refresh = store.refresh();
  while (pending.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  store.upsert({ ...research, name: '别处新建后又改名' });
  pending.shift()!([research, fallback]);
  await refresh;
  assert.deepEqual(store.snapshot()?.map((item) => item.name), ['别处新建后又改名', '默认工作区']);

  failures.push(true);
  await assert.rejects(store.refresh(), /网络错误/u);
  assert.deepEqual(store.snapshot()?.map((item) => item.workspaceId), ['research', 'default']);
});
