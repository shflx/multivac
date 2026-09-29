import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolAuthorizationGrant } from '@multivac/contracts';
import { AuthorizationGrants, grantsOf } from '../src/features/authorizations/authorization-grants.js';

function grant(grantId: string, overrides: Partial<ToolAuthorizationGrant> = {}): ToolAuthorizationGrant {
  return {
    grantId, scope: 'session', sessionId: 'work-1', projectId: null, access: 'write', directory: '/data/reports',
    sourceRequestId: `request-${grantId}`, createdAt: '2026-09-28T08:00:00.000Z', lastUsedAt: null, useCount: 0,
    revokedAt: null, ...overrides,
  };
}

/** 可以手动决定何时返回的读取。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('按归属筛选：会话只看本会话内的，项目只看本项目内的', () => {
  const grants = [
    grant('a'),
    grant('b', { sessionId: 'work-2' }),
    grant('c', { scope: 'project', sessionId: null, projectId: 'project-1' }),
    grant('d', { scope: 'project', sessionId: null, projectId: 'project-2' }),
  ];
  assert.deepEqual(grantsOf(grants, { sessionId: 'work-1' }).map((item) => item.grantId), ['a']);
  assert.deepEqual(grantsOf(grants, { projectId: 'project-1' }).map((item) => item.grantId), ['c']);
  assert.deepEqual(grantsOf(grants, { sessionId: 'project-1' }), []);
});

test('共享的授权列表：重新读取取最近一次发起的结果；撤销后立即去掉，撤销前发出的读取也不会把它带回来', async () => {
  const reads: Array<ReturnType<typeof deferred<readonly ToolAuthorizationGrant[]>>> = [];
  const revoked: string[] = [];
  let failRevoke = false;
  const store = new AuthorizationGrants({
    list: () => {
      const read = deferred<readonly ToolAuthorizationGrant[]>();
      reads.push(read);
      return read.promise;
    },
    revoke: async (grantId) => {
      if (failRevoke) throw new Error('网络错误');
      revoked.push(grantId);
    },
  });
  let published = 0;
  store.subscribe(() => { published += 1; });
  assert.equal(store.snapshot(), null);

  // 两次读取：较早发出的晚返回，不覆盖较新的结果。
  const older = store.refresh();
  const newer = store.refresh();
  reads[1]!.resolve([grant('a'), grant('b')]);
  await newer;
  reads[0]!.resolve([grant('a')]);
  await older;
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['a', 'b']);
  assert.equal(published, 1);

  // 撤销失败：列表不变，错误交给调用方（确认卡上显示）。
  failRevoke = true;
  await assert.rejects(store.revoke('a'), /网络错误/u);
  assert.equal(store.snapshot()?.length, 2);

  // 撤销期间发出的读取晚于撤销返回：结果里仍有它，落地时去掉。
  failRevoke = false;
  const during = store.refresh();
  await store.revoke('a');
  assert.deepEqual(revoked, ['a']);
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['b']);
  const snapshot = store.snapshot();
  reads[2]!.resolve([grant('a'), grant('b'), grant('c')]);
  await during;
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['b', 'c']);
  assert.notEqual(store.snapshot(), snapshot);

  // 读取失败：保留已有列表。
  const failing = store.refresh();
  reads[3]!.resolve(Promise.reject(new Error('读取失败')) as never);
  await assert.rejects(failing, /读取失败/u);
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['b', 'c']);
});

test('别处的变化：新记住的授权排在最前，撤销的去掉且之后的读取不再带回；读取期间推送来的新授权不被较早的结果漏掉', async () => {
  const reads: Array<ReturnType<typeof deferred<readonly ToolAuthorizationGrant[]>>> = [];
  const store = new AuthorizationGrants({
    list: () => {
      const read = deferred<readonly ToolAuthorizationGrant[]>();
      reads.push(read);
      return read.promise;
    },
    revoke: async () => undefined,
  });

  // 尚未读取：新授权等首次读取，撤销先记下；也不因重连而读取。
  store.applyChange('created', grant('early'));
  store.applyChange('revoked', grant('gone'));
  store.refreshIfLoaded();
  assert.equal(reads.length, 0);
  assert.equal(store.snapshot(), null);

  const first = store.refresh();
  // 读取在服务端完成之后，另一个窗口记住了 c。
  store.applyChange('created', grant('c'));
  reads[0]!.resolve([grant('a'), grant('gone')]);
  await first;
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['c', 'a']);

  // 已在列表中的不重复；撤销即时去掉，之后的读取不带回。
  store.applyChange('created', grant('c'));
  store.applyChange('created', grant('d'));
  store.applyChange('revoked', grant('a'));
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['d', 'c']);
  store.applyChange('created', grant('a'));
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['d', 'c']);

  // 已读取过：重连后重读一次。
  store.refreshIfLoaded();
  assert.equal(reads.length, 2);
  reads[1]!.resolve([grant('d'), grant('c'), grant('a')]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(store.snapshot()?.map((item) => item.grantId), ['d', 'c']);
});
