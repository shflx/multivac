import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Workspace, WorkspaceSession } from '@multivac/contracts';
import {
  archiveWorkspaceSession,
  listWorkspaces,
  listWorkspaceSessions,
  moveSessionToProject,
  renameWorkspaceSession,
  restoreWorkspaceSession,
} from '../../data/workspace-api.js';
import { WorkspaceSessions } from './workspace-sessions.js';
import { Workspaces } from './workspaces.js';

const WorkspaceSessionsContext = createContext<{ sessions: WorkspaceSessions; workspaces: Workspaces } | null>(null);

/** 应用级的工作区与工作会话列表：工作区与设置 · 归档页共用同一份。 */
export function WorkspaceSessionsProvider({ children }: { children: ReactNode }) {
  const [stores] = useState(() => ({
    sessions: new WorkspaceSessions({
      // 全部工作区的会话（含已归档）；各工作区按会话的 workspaceId 取自己的会话。
      list: async () => (await listWorkspaceSessions({ includeArchived: true, allWorkspaces: true })).sessions,
      rename: renameWorkspaceSession,
      archive: archiveWorkspaceSession,
      restore: restoreWorkspaceSession,
      moveToProject: moveSessionToProject,
    }),
    workspaces: new Workspaces(listWorkspaces),
  }));
  return <WorkspaceSessionsContext.Provider value={stores}>{children}</WorkspaceSessionsContext.Provider>;
}

/** 共享的会话与工作区列表本身（工作台变更同步据此写回别处的变化）。 */
export function useWorkspaceStores(): { sessions: WorkspaceSessions; workspaces: Workspaces } {
  const stores = useContext(WorkspaceSessionsContext);
  if (!stores) throw new Error('工作区列表必须在 WorkspaceSessionsProvider 内使用。');
  return stores;
}


export interface WorkspaceSessionsHandle
  extends Pick<WorkspaceSessions, 'ensureLoaded' | 'upsert' | 'rename' | 'archive' | 'restore' | 'moveToProject'> {
  /** 全部工作区的工作会话（含已归档），按创建时间升序；尚未读取成功时为 null。 */
  sessions: readonly WorkspaceSession[] | null;
}

/** 订阅共享的工作会话列表；改名、归档、恢复与归入项目经这里完成，结果同时出现在各处。 */
export function useWorkspaceSessions(): WorkspaceSessionsHandle {
  const store = useWorkspaceStores().sessions;
  const sessions = useSyncExternalStore(store.subscribe, store.snapshot);
  const { ensureLoaded, upsert, rename, archive, restore, moveToProject } = store;
  return { sessions, ensureLoaded, upsert, rename, archive, restore, moveToProject };
}

export interface WorkspacesHandle extends Pick<Workspaces, 'ensureLoaded' | 'upsert'> {
  /** 全部工作区：项目工作区在前，默认工作区在最后；尚未读取成功时为 null。 */
  workspaces: readonly Workspace[] | null;
}

/** 订阅共享的工作区列表（含项目与目录）。 */
export function useWorkspaces(): WorkspacesHandle {
  const store = useWorkspaceStores().workspaces;
  const workspaces = useSyncExternalStore(store.subscribe, store.snapshot);
  const { ensureLoaded, upsert } = store;
  return { workspaces, ensureLoaded, upsert };
}
