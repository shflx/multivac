import {
  resolvedScene,
  type WindowNavigationTarget,
  type WorkbenchChangeOrigin,
  type WorkbenchEvent,
  type WorkspaceScene,
  type WorkspaceSceneState,
} from '@multivac/contracts';
import type { AuthorizationGrants } from '../authorizations/authorization-grants.js';
import type { Proposals } from '../proposals/proposals.js';
import type { WorkspaceSessions } from '../workspace/workspace-sessions.js';
import type { Workspaces } from '../workspace/workspaces.js';

/**
 * 工作台变更事件在本窗口的应用规则（与界面无关，便于单独测试）。
 *
 * - 本窗口直接发起的改动（来源窗口是本窗口、不在 Multivac 的一轮中）已按接口返回写回，不重复应用；
 * - 其他窗口的改动、Multivac 经内部工具所做的改动（即使消息从本窗口发出）以快照写回共享列表（含对话内的提议）；
 * - 事件流连上（含断线重连）时，已读取过的共享列表各重读一次，补齐断线期间的变化。
 */

export interface WorkbenchStores {
  sessions: Pick<WorkspaceSessions, 'upsert' | 'refresh'>;
  workspaces: Pick<Workspaces, 'upsert' | 'refresh'>;
  grants: Pick<AuthorizationGrants, 'applyChange' | 'refreshIfLoaded'>;
  proposals: Pick<Proposals, 'apply' | 'refreshIfLoaded'>;
}

/** 是否是本窗口直接发起的改动：界面操作的结果已由本窗口按接口返回写回。 */
export function isOwnDirectChange(origin: WorkbenchChangeOrigin, windowId: string): boolean {
  return origin.windowId === windowId && origin.commandId === null;
}

/** 把一条变更写回共享列表；现场由各工作区视图按 `sceneEventAction` 自行处理。返回是否写回。 */
export function applyWorkbenchEvent(event: WorkbenchEvent, stores: WorkbenchStores, windowId: string): boolean {
  if (event.type === 'workbench.connected' || event.type === 'scene.changed' || event.type === 'window.navigate') return false;
  if (isOwnDirectChange(event.origin, windowId)) return false;
  switch (event.type) {
    case 'session.changed':
      stores.sessions.upsert(event.session);
      return true;
    case 'workspace.changed':
      stores.workspaces.upsert(event.workspace);
      return true;
    case 'grant.changed':
      stores.grants.applyChange(event.change, event.grant);
      return true;
    case 'proposal.changed':
      stores.proposals.apply(event.proposal);
      return true;
  }
}

/**
 * Multivac 应用户明确要求切换界面时只推给发起窗口的导航：本窗口是否照做。服务端只推给发起窗口，这里再核对一次来源；
 * 窄屏时工作区与管理不可用，不切换（服务端按发送时的视图已在回执中说明，发送后才变窄的同样不切换）。
 */
export function navigationToFollow(
  event: WorkbenchEvent,
  view: { windowId: string; narrow: boolean },
): WindowNavigationTarget | null {
  if (event.type !== 'window.navigate' || event.origin.windowId !== view.windowId || view.narrow) return null;
  return event.target;
}

/** 事件流连上（含重连）后整体重读已读取过的共享列表；失败时保留现有内容，下次重连再补。 */
export function resyncWorkbench(stores: WorkbenchStores): void {
  stores.sessions.refresh().catch(() => undefined);
  stores.workspaces.refresh().catch(() => undefined);
  stores.grants.refreshIfLoaded();
  stores.proposals.refreshIfLoaded();
}

/**
 * 现场事件对某个工作区视图的意义：
 * - ignore：不是这个工作区，或不比本窗口已知的版本新；
 * - acknowledge：本窗口直接发起的保存（或本窗口的归档、归入项目让服务端移出了会话）——内容本窗口已有，
 *   只记下新版本，之后的保存基于它；本窗口此后未保存的布局变化随之照常保存；
 * - apply：别处的改动（其他窗口、Multivac）——以服务端为准应用到布局，本窗口尚未保存的改动按 `rebaseSceneChanges` 保留。
 */
export function sceneEventAction(
  scene: WorkspaceScene,
  origin: WorkbenchChangeOrigin,
  view: { workspaceId: string; knownRevision: number; windowId: string },
): 'ignore' | 'acknowledge' | 'apply' {
  if (scene.workspaceId !== view.workspaceId || scene.revision <= view.knownRevision) return 'ignore';
  return isOwnDirectChange(origin, view.windowId) ? 'acknowledge' : 'apply';
}

/** 现场中分别合并的部分：布局（并排数、栏位、当前会话、视图）互相关联，作为一个整体；列宽、工作区条各自独立。 */
const SCENE_PARTS: ReadonlyArray<(scene: WorkspaceSceneState) => unknown> = [
  (scene) => [scene.parallelCount, scene.slots, scene.focusedSessionId, scene.viewMode],
  (scene) => scene.widths,
  (scene) => scene.barVisible,
];

/**
 * 应用别处的现场时，保留本窗口尚未保存的改动：以服务端为准，只有本窗口改过的部分（与上次和服务端一致的现场相比）
 * 取本窗口的，随后保存在新版本之上。例如另一个窗口只是把新会话补进空栏并保存，本窗口刚点的“在工作区打开”不会被撤销。
 *
 * - base：本窗口上次与服务端一致的现场（读取、保存成功或应用别处现场时的内容）；
 * - local：本窗口当前呈现的现场；
 * - remote：别处保存的现场。
 *
 * 比较在按同一份会话列表补位后的呈现上进行，补位造成的差别不算本窗口的改动；没有改动时原样返回 remote。
 */
export function rebaseSceneChanges(
  base: WorkspaceSceneState,
  local: WorkspaceSceneState,
  remote: WorkspaceSceneState,
  members: readonly string[],
): WorkspaceSceneState {
  const presentedBase = resolvedScene(base, members);
  const presentedLocal = resolvedScene(local, members);
  const changed = SCENE_PARTS.map((part) => JSON.stringify(part(presentedLocal)) !== JSON.stringify(part(presentedBase)));
  if (!changed.includes(true)) return remote;
  const [layout, widths, bar] = changed;
  return {
    ...(layout
      ? {
          parallelCount: presentedLocal.parallelCount,
          slots: presentedLocal.slots,
          focusedSessionId: presentedLocal.focusedSessionId,
          viewMode: presentedLocal.viewMode,
        }
      : {
          parallelCount: remote.parallelCount,
          slots: remote.slots,
          focusedSessionId: remote.focusedSessionId,
          viewMode: remote.viewMode,
        }),
    widths: widths ? presentedLocal.widths : remote.widths,
    barVisible: bar ? presentedLocal.barVisible : remote.barVisible,
  };
}
