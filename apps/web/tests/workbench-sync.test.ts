import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ToolAuthorizationGrant,
  WorkbenchChangeOrigin,
  WorkbenchEvent,
  Workspace,
  WorkspaceScene,
  WorkspaceSession,
} from '@multivac/contracts';
import {
  applyWorkbenchEvent,
  isOwnDirectChange,
  resyncWorkbench,
  sceneEventAction,
  type WorkbenchStores,
} from '../src/features/workbench/workbench-sync.js';
import { resolvedScene } from '../src/features/workspace/workspace-slots.js';

const ME = 'window-me';
const direct = (windowId: string | null): WorkbenchChangeOrigin => ({ windowId, commandId: null });
const multivac = (windowId: string | null): WorkbenchChangeOrigin => ({ windowId, commandId: 'turn-1' });

const session: WorkspaceSession = {
  sessionId: 's-1', title: '会话', kind: 'work', workspaceId: 'default', createdAt: 't', archivedAt: null,
  parentSessionId: null, originText: null, workingDirectory: { kind: 'session-temp', path: '/work/sessions/s-1' },
};
const workspace: Workspace = { workspaceId: 'p-1', name: '研究', project: null };
const grant: ToolAuthorizationGrant = {
  grantId: 'g-1', scope: 'session', sessionId: 's-1', projectId: null, access: 'write', directory: '/data',
  sourceRequestId: 'r-1', createdAt: 't', lastUsedAt: null, useCount: 0, revokedAt: null,
};

function stores() {
  const calls: string[] = [];
  const target: WorkbenchStores = {
    sessions: {
      upsert: (item) => { calls.push(`session:${item.sessionId}:${item.title}`); },
      refresh: async () => { calls.push('sessions.refresh'); },
    },
    workspaces: {
      upsert: (item) => { calls.push(`workspace:${item.workspaceId}`); },
      refresh: async () => { calls.push('workspaces.refresh'); },
    },
    grants: {
      applyChange: (change, item) => { calls.push(`grant.${change}:${item.grantId}`); },
      refreshIfLoaded: () => { calls.push('grants.refresh'); },
    },
  };
  return { target, calls };
}

test('只有本窗口直接发起的改动算作自己的：Multivac 在本窗口发起的一轮中的改动、其他窗口与来源不明的都要应用', () => {
  assert.equal(isOwnDirectChange(direct(ME), ME), true);
  assert.equal(isOwnDirectChange(multivac(ME), ME), false);
  assert.equal(isOwnDirectChange(direct('window-other'), ME), false);
  assert.equal(isOwnDirectChange(direct(null), ME), false);
});

test('会话、工作区与记住的授权按快照写回共享列表，本窗口直接发起的不重复应用；连上或重连时整体重读', () => {
  const { target, calls } = stores();
  const events: WorkbenchEvent[] = [
    { type: 'session.changed', seq: 1, origin: direct(ME), change: 'renamed', session: { ...session, title: '自己改的' } },
    { type: 'session.changed', seq: 2, origin: direct('window-other'), change: 'renamed', session: { ...session, title: '别处改的' } },
    { type: 'session.changed', seq: 3, origin: multivac(ME), change: 'archived', session: { ...session, title: 'Multivac 归档的' } },
    { type: 'workspace.changed', seq: 4, origin: direct(null), change: 'created', workspace },
    { type: 'workspace.changed', seq: 5, origin: direct(ME), change: 'updated', workspace },
    { type: 'grant.changed', seq: 6, origin: direct('window-other'), change: 'revoked', grant },
    { type: 'grant.changed', seq: 7, origin: direct(ME), change: 'created', grant },
  ];
  assert.deepEqual(events.map((event) => applyWorkbenchEvent(event, target, ME)), [false, true, true, true, false, true, false]);
  assert.deepEqual(calls, ['session:s-1:别处改的', 'session:s-1:Multivac 归档的', 'workspace:p-1', 'grant.revoked:g-1']);

  // 现场与连接消息不写回共享列表（现场由工作区视图按版本处理）。
  calls.length = 0;
  const scene: WorkspaceScene = {
    workspaceId: 'default', revision: 3,
    scene: { parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'parallel', widths: {}, barVisible: true },
  };
  assert.equal(applyWorkbenchEvent({ type: 'scene.changed', seq: 8, origin: direct(null), scene }, target, ME), false);
  assert.equal(applyWorkbenchEvent({ type: 'workbench.connected', seq: 9, windowId: ME }, target, ME), false);
  assert.deepEqual(calls, []);

  resyncWorkbench(target);
  assert.deepEqual(calls, ['sessions.refresh', 'workspaces.refresh', 'grants.refresh']);
});

test('现场事件：别的工作区与不更新的版本忽略；本窗口直接保存的只记下版本；其他窗口与 Multivac 的改动以服务端为准应用', () => {
  const scene = (revision: number, workspaceId = 'default'): WorkspaceScene => ({
    workspaceId, revision,
    scene: { parallelCount: 2, slots: ['a'], focusedSessionId: 'a', viewMode: 'focus', widths: {}, barVisible: true },
  });
  const view = { workspaceId: 'default', knownRevision: 4, windowId: ME };
  assert.equal(sceneEventAction(scene(5, 'p-1'), direct('window-other'), view), 'ignore');
  assert.equal(sceneEventAction(scene(4), direct('window-other'), view), 'ignore');
  assert.equal(sceneEventAction(scene(3), multivac(ME), view), 'ignore');
  assert.equal(sceneEventAction(scene(5), direct(ME), view), 'acknowledge');
  assert.equal(sceneEventAction(scene(5), direct('window-other'), view), 'apply');
  assert.equal(sceneEventAction(scene(5), multivac(ME), view), 'apply');
  assert.equal(sceneEventAction(scene(5), direct(null), view), 'apply');
});

test('呈现的现场：空栏按列表顺序补位，当前会话不在工作区中时取第一栏；应用别处的现场前据此算出将呈现的结果', () => {
  const members = ['c', 'b', 'a'];
  assert.deepEqual(resolvedScene({
    parallelCount: 3, slots: ['b', 'gone'], focusedSessionId: 'gone', viewMode: 'parallel', widths: { 3: [1, 1, 2] }, barVisible: false,
  }, members), {
    parallelCount: 3, slots: ['b', 'c', 'a'], focusedSessionId: 'b', viewMode: 'parallel', widths: { 3: [1, 1, 2] }, barVisible: false,
  });
  assert.equal(resolvedScene({
    parallelCount: 2, slots: [], focusedSessionId: 'a', viewMode: 'focus', widths: {}, barVisible: true,
  }, members).focusedSessionId, 'a');
  assert.equal(resolvedScene({
    parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'focus', widths: {}, barVisible: true,
  }, []).focusedSessionId, null);
});
