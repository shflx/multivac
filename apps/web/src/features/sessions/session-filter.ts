import type { WorkspaceSession } from '@multivac/contracts';

/**
 * 管理 · 会话页的筛选：按工作区、状态、类型筛选，按标题搜索。与界面无关，便于单独测试。
 * 多工作区之后，工作区筛选改为按项目 / 工作区。
 */

/** 状态：进行中（未归档）、已归档、全部。 */
export type SessionStatusFilter = 'active' | 'archived' | 'all';
/** 类型：顶层会话、栈式子会话（有父会话）、全部。 */
export type SessionKindFilter = 'all' | 'top' | 'stacked';

export interface SessionFilter {
  /** 工作区 id；'all' 为全部工作区。 */
  workspaceId: string;
  status: SessionStatusFilter;
  kind: SessionKindFilter;
  /** 按标题搜索，忽略首尾空白与大小写；为空时不限。 */
  query: string;
}

export const ALL_WORKSPACES = 'all';

export const DEFAULT_SESSION_FILTER: SessionFilter = {
  workspaceId: ALL_WORKSPACES,
  status: 'active',
  kind: 'all',
  query: '',
};

export const SESSION_STATUS_OPTIONS: ReadonlyArray<{ value: SessionStatusFilter; label: string }> = [
  { value: 'active', label: '进行中' },
  { value: 'archived', label: '已归档' },
  { value: 'all', label: '全部' },
];

export const SESSION_KIND_OPTIONS: ReadonlyArray<{ value: SessionKindFilter; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'top', label: '顶层' },
  { value: 'stacked', label: '栈式子会话' },
];

export function isStackedSession(session: WorkspaceSession): boolean {
  return session.parentSessionId !== null;
}

/** 会话类型的说明文字：列表与详情共用。 */
export function sessionKindLabel(session: WorkspaceSession): string {
  return isStackedSession(session) ? '栈式子会话' : '顶层会话';
}

/** 符合筛选条件的会话，新建的在前（与工作区会话列表的顺序一致）。sessions 按创建时间升序。 */
export function filterSessions(sessions: readonly WorkspaceSession[], filter: SessionFilter): WorkspaceSession[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (filter.workspaceId !== ALL_WORKSPACES && session.workspaceId !== filter.workspaceId) return false;
    if (filter.status !== 'all' && (filter.status === 'archived') !== (session.archivedAt !== null)) return false;
    if (filter.kind !== 'all' && (filter.kind === 'stacked') !== isStackedSession(session)) return false;
    return !query || session.title.toLocaleLowerCase().includes(query);
  }).reverse();
}

/** 会话所在的工作区 id，按首次出现的顺序去重；只有一个时不需要工作区筛选。 */
export function sessionWorkspaceIds(sessions: readonly WorkspaceSession[]): string[] {
  return [...new Set(sessions.map((session) => session.workspaceId))];
}
