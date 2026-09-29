import type { Workspace, WorkspaceSession } from '@multivac/contracts';

/**
 * 管理 · 会话页的筛选：按项目（即所在工作区：项目工作区与默认工作区）、状态、类型筛选，按标题搜索。
 * 与界面无关，便于单独测试。
 */

/** 状态：进行中（未归档）、已归档、全部。 */
export type SessionStatusFilter = 'active' | 'archived' | 'all';
/** 类型：顶层会话、栈式子会话（有父会话）、全部。 */
export type SessionKindFilter = 'all' | 'top' | 'stacked';

export interface SessionFilter {
  /** 工作区 id；'all' 为全部。项目与工作区一一对应，默认工作区即“不属于项目”。 */
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

/**
 * 项目筛选的选项：全部项目、各项目（项目工作区，名称即项目名称）、不属于项目（默认工作区）。
 * 还没有项目时筛选没有意义，返回 null（界面不显示）；所在仍写在每一行和详情里。
 */
export function projectFilterOptions(
  workspaces: readonly Workspace[],
): Array<{ value: string; label: string }> | null {
  if (!workspaces.some((workspace) => workspace.project)) return null;
  return [
    { value: ALL_WORKSPACES, label: '全部项目' },
    ...workspaces.filter((workspace) => workspace.project).map((workspace) => ({
      value: workspace.workspaceId,
      label: workspace.name,
    })),
    ...workspaces.filter((workspace) => !workspace.project).map((workspace) => ({
      value: workspace.workspaceId,
      label: '不属于项目',
    })),
  ];
}

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
