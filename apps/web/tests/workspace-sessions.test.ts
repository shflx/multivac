import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceSession } from '@multivac/contracts';
import { WorkspaceSessions, type WorkspaceSessionsApi } from '../src/features/workspace/workspace-sessions.js';

function session(sessionId: string, patch: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    sessionId,
    title: sessionId,
    kind: 'work',
    workspaceId: 'default',
    createdAt: '2026-09-28T08:00:00.000Z',
    archivedAt: null,
    parentSessionId: null,
    originText: null,
    workingDirectory: { kind: 'session-temp', path: `/work/sessions/${sessionId}` },
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 按脚本返回的接口替身：list 每次调用取下一个结果，其余操作按参数生成服务端返回的会话。 */
function fakeApi(lists: Array<Promise<readonly WorkspaceSession[]>>) {
  let listCalls = 0;
  const api: WorkspaceSessionsApi = {
    list: () => lists[listCalls++] ?? Promise.reject(new Error('没有更多列表')),
    rename: async (sessionId, title) => session(sessionId, { title }),
    archive: async (sessionId) => session(sessionId, { archivedAt: '2026-09-28T09:00:00.000Z' }),
    restore: async (sessionId) => ({ session: session(sessionId), trashedDirectory: null }),
    moveToProject: async (sessionId, input) => ({
      session: session(sessionId, {
        workspaceId: input.projectId,
        workingDirectory: { kind: 'project-managed', path: `/work/projects/${input.projectId}` },
      }),
      files: null,
      sourceRemoved: true,
      tempRetentionDays: 30,
    }),
  };
  return { api, listCalls: () => listCalls };
}

test('并发读取共用一个请求；读取失败后再次读取会重新请求', async () => {
  const first = deferred<readonly WorkspaceSession[]>();
  const { api, listCalls } = fakeApi([first.promise, Promise.resolve([session('a')])]);
  const store = new WorkspaceSessions(api);
  let notified = 0;
  store.subscribe(() => { notified += 1; });

  const loads = [store.ensureLoaded(), store.ensureLoaded()];
  assert.equal(listCalls(), 1);
  assert.equal(store.snapshot(), null);
  first.reject(new Error('网络中断'));
  for (const load of loads) await assert.rejects(load, /网络中断/);
  assert.equal(store.snapshot(), null);
  assert.equal(notified, 0);

  await store.ensureLoaded();
  assert.equal(listCalls(), 2);
  assert.deepEqual(store.snapshot()?.map((item) => item.sessionId), ['a']);
  // 已读取后不再请求，快照引用保持不变。
  const snapshot = store.snapshot();
  await store.ensureLoaded();
  assert.equal(listCalls(), 2);
  assert.equal(store.snapshot(), snapshot);
});

test('改名、归档、恢复、新建与归入项目都以服务端返回的会话写回同一份列表，位置不变', async () => {
  const { api } = fakeApi([Promise.resolve([session('a'), session('b')])]);
  const store = new WorkspaceSessions(api);
  await store.ensureLoaded();
  const ids = () => store.snapshot()?.map((item) => `${item.sessionId}:${item.title}:${item.archivedAt ? '归档' : '进行中'}`);

  assert.equal((await store.rename('a', '改过的名')).title, '改过的名');
  assert.deepEqual(ids(), ['a:改过的名:进行中', 'b:b:进行中']);

  await store.archive('a');
  assert.deepEqual(ids(), ['a:a:归档', 'b:b:进行中']);

  assert.equal((await store.restore('a')).trashedDirectory, null);
  assert.deepEqual(ids(), ['a:a:进行中', 'b:b:进行中']);

  // 新建（或栈式深入）的会话追加在末尾，与服务端按创建时间升序一致。
  store.upsert(session('c'));
  assert.deepEqual(ids(), ['a:a:进行中', 'b:b:进行中', 'c:c:进行中']);

  // 归入项目：返回结果中的会话写回原位，工作区与工作目录随之更新。
  const moved = await store.moveToProject('b', { projectId: 'p-1', moveFiles: false });
  assert.equal(moved.sourceRemoved, true);
  assert.deepEqual(
    store.snapshot()?.map((item) => [item.sessionId, item.workspaceId, item.workingDirectory.kind]),
    [['a', 'default', 'session-temp'], ['b', 'p-1', 'project-managed'], ['c', 'default', 'session-temp']],
  );
});

test('读取期间写回的会话不会被较早的读取结果覆盖', async () => {
  const listed = deferred<readonly WorkspaceSession[]>();
  const { api } = fakeApi([listed.promise]);
  const store = new WorkspaceSessions(api);

  const load = store.ensureLoaded();
  await store.archive('a');
  store.upsert(session('new'));
  // 列表请求在归档与新建之前就已由服务端处理完。
  listed.resolve([session('a'), session('b')]);
  await load;

  assert.deepEqual(
    store.snapshot()?.map((item) => [item.sessionId, item.archivedAt !== null]),
    [['a', true], ['b', false], ['new', false]],
  );
});
