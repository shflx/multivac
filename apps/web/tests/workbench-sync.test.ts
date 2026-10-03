import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Proposal,
  ToolAuthorizationGrant,
  WorkbenchChangeOrigin,
  WorkbenchEvent,
  Workspace,
  WorkspaceScene,
  WorkspaceSceneState,
  WorkspaceSession,
} from '@multivac/contracts';
import {
  applyWorkbenchEvent,
  isOwnDirectChange,
  navigationToFollow,
  rebaseSceneChanges,
  resyncWorkbench,
  sceneEventAction,
  type WorkbenchStores,
} from '../src/features/workbench/workbench-sync.js';

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

const proposal: Proposal = {
  proposalId: 'pr-1', sessionId: 'global-coordinator', commandId: 'turn-1', toolCallId: 'call-1', kind: 'example.rename_session',
  title: '把会话「会话」改名为「新」', payload: {}, preview: {}, problem: null, status: 'pending', outcome: null, reason: null,
  createdAt: 't', decidedAt: null,
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
    proposals: {
      apply: (item) => { calls.push(`proposal:${item.proposalId}:${item.status}`); },
      refreshIfLoaded: () => { calls.push('proposals.refresh'); },
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

test('书伴活动不会写入 Coding 工作区的会话缓存', () => {
  const { target, calls } = stores();
  const event: WorkbenchEvent = { type: 'session.changed', seq: 1, origin: direct(null), change: 'activity', session: { ...session, host: { kind: 'reading', bookId: 'book1', title: '真实书籍' } } };
  assert.equal(applyWorkbenchEvent(event, target, ME), false);
  assert.deepEqual(calls, []);
});

test('会话、工作区、记住的授权与提议按快照写回共享列表，本窗口直接发起的不重复应用；连上或重连时整体重读', () => {
  const { target, calls } = stores();
  const events: WorkbenchEvent[] = [
    { type: 'session.changed', seq: 1, origin: direct(ME), change: 'renamed', session: { ...session, title: '自己改的' } },
    { type: 'session.changed', seq: 2, origin: direct('window-other'), change: 'renamed', session: { ...session, title: '别处改的' } },
    { type: 'session.changed', seq: 3, origin: multivac(ME), change: 'archived', session: { ...session, title: 'Multivac 归档的' } },
    { type: 'workspace.changed', seq: 4, origin: direct(null), change: 'created', workspace },
    { type: 'workspace.changed', seq: 5, origin: direct(ME), change: 'updated', workspace },
    { type: 'grant.changed', seq: 6, origin: direct('window-other'), change: 'revoked', grant },
    { type: 'grant.changed', seq: 7, origin: direct(ME), change: 'created', grant },
    { type: 'proposal.changed', seq: 8, origin: multivac(ME), change: 'created', proposal },
    { type: 'proposal.changed', seq: 9, origin: direct('window-other'), change: 'updated', proposal: { ...proposal, status: 'cancelled' } },
    { type: 'proposal.changed', seq: 10, origin: direct(ME), change: 'updated', proposal: { ...proposal, status: 'executed' } },
  ];
  assert.deepEqual(events.map((event) => applyWorkbenchEvent(event, target, ME)), [
    false, true, true, true, false, true, false, true, true, false,
  ]);
  assert.deepEqual(calls, [
    'session:s-1:别处改的', 'session:s-1:Multivac 归档的', 'workspace:p-1', 'grant.revoked:g-1',
    'proposal:pr-1:pending', 'proposal:pr-1:cancelled',
  ]);

  // 现场与连接消息不写回共享列表（现场由工作区视图按版本处理）。
  calls.length = 0;
  const scene: WorkspaceScene = {
    workspaceId: 'default', revision: 3,
    scene: { parallelCount: 2, slots: [], focusedSessionId: null, viewMode: 'parallel', widths: {}, barVisible: true },
  };
  assert.equal(applyWorkbenchEvent({ type: 'scene.changed', seq: 8, origin: direct(null), scene }, target, ME), false);
  assert.equal(applyWorkbenchEvent({ type: 'workbench.connected', seq: 9, windowId: ME }, target, ME), false);
  assert.equal(applyWorkbenchEvent({
    type: 'window.navigate', seq: 10, origin: multivac(ME), target: { kind: 'management', page: 'models', selection: null },
  }, target, ME), false);
  assert.deepEqual(calls, []);

  resyncWorkbench(target);
  assert.deepEqual(calls, ['sessions.refresh', 'workspaces.refresh', 'grants.refresh', 'proposals.refresh']);
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

test('应用别处的现场：本窗口没有改动时以服务端为准；本窗口改过的部分（布局、列宽、工作区条）保留，补位的差别不算改动', () => {
  const members = ['new', 'old'];
  const layout = (patch: Partial<WorkspaceSceneState>): WorkspaceSceneState => ({
    parallelCount: 2, slots: ['old'], focusedSessionId: 'old', viewMode: 'parallel', widths: {}, barVisible: true, ...patch,
  });
  // 另一个窗口把新会话补进空栏并保存。
  const base = layout({});
  const filled = layout({ slots: ['old', 'new'] });

  // 本窗口没有改动（呈现上的补位与服务端相同）：原样采用服务端的现场。
  assert.equal(rebaseSceneChanges(base, layout({ slots: ['old', 'new'] }), filled, members), filled);
  assert.equal(rebaseSceneChanges(base, base, filled, members), filled);

  // 本窗口刚在工作区打开新会话（尚未保存）：布局以本窗口为准，不被别处的补位撤销。
  const opened = layout({ slots: ['old', 'new'], focusedSessionId: 'new', viewMode: 'focus' });
  assert.deepEqual(rebaseSceneChanges(base, opened, filled, members), opened);

  // 各部分分别合并：本窗口只拖动了列宽、别处改了当前会话与工作区条，两边的改动都保留。
  const dragged = layout({ widths: { 2: [0.4, 0.6] } });
  const remote = layout({ slots: ['old', 'new'], focusedSessionId: 'new', barVisible: false });
  assert.deepEqual(rebaseSceneChanges(base, dragged, remote, members), { ...remote, widths: { 2: [0.4, 0.6] } });
});

test('Multivac 的导航：只在发起窗口照做，窄屏时不切换；其他事件不是导航', () => {
  const navigate = (windowId: string | null): WorkbenchEvent => ({
    type: 'window.navigate', seq: 1, origin: multivac(windowId),
    target: { kind: 'workspace', workspaceId: 'p-1', sessionId: 's-1' },
  });
  assert.deepEqual(navigationToFollow(navigate(ME), { windowId: ME, narrow: false }),
    { kind: 'workspace', workspaceId: 'p-1', sessionId: 's-1' });
  assert.equal(navigationToFollow(navigate('window-other'), { windowId: ME, narrow: false }), null);
  assert.equal(navigationToFollow(navigate(null), { windowId: ME, narrow: false }), null);
  assert.equal(navigationToFollow(navigate(ME), { windowId: ME, narrow: true }), null);
  assert.equal(navigationToFollow({ type: 'workbench.connected', seq: 2, windowId: ME }, { windowId: ME, narrow: false }), null);
});
