import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WorkspaceSession } from '@multivac/contracts';
import {
  archiveWorkspaceSession,
  listWorkspaceSessions,
  renameWorkspaceSession,
  restoreWorkspaceSession,
} from '../../data/workspace-api.js';
import { WorkspaceSessions } from './workspace-sessions.js';

const WorkspaceSessionsContext = createContext<WorkspaceSessions | null>(null);

/** 应用级的工作会话列表：工作区与管理 · 会话页共用同一份。 */
export function WorkspaceSessionsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new WorkspaceSessions({
    // 目前只有默认工作区，这个列表就是全部工作会话；多工作区之后改为跨工作区的列表接口。
    list: async () => (await listWorkspaceSessions({ includeArchived: true })).sessions,
    rename: renameWorkspaceSession,
    archive: archiveWorkspaceSession,
    restore: restoreWorkspaceSession,
  }));
  return <WorkspaceSessionsContext.Provider value={store}>{children}</WorkspaceSessionsContext.Provider>;
}

export interface WorkspaceSessionsHandle
  extends Pick<WorkspaceSessions, 'ensureLoaded' | 'upsert' | 'rename' | 'archive' | 'restore'> {
  /** 全部工作会话（含已归档），按创建时间升序；尚未读取成功时为 null。 */
  sessions: readonly WorkspaceSession[] | null;
}

/** 订阅共享的工作会话列表；改名、归档、恢复经这里完成，结果同时出现在各处。 */
export function useWorkspaceSessions(): WorkspaceSessionsHandle {
  const store = useContext(WorkspaceSessionsContext);
  if (!store) throw new Error('useWorkspaceSessions 必须在 WorkspaceSessionsProvider 内使用。');
  const sessions = useSyncExternalStore(store.subscribe, store.snapshot);
  const { ensureLoaded, upsert, rename, archive, restore } = store;
  return { sessions, ensureLoaded, upsert, rename, archive, restore };
}
