import type { Workspace, WorkspaceSession } from '@multivac/contracts';

export const ALL_WORKSPACES = 'all';
export interface ArchiveFilter { workspaceId: string; query: string }
export const DEFAULT_ARCHIVE_FILTER: ArchiveFilter = { workspaceId: ALL_WORKSPACES, query: '' };

/** 只展示工作会话，按实际归档时间倒序；不受创建顺序和栈式层级影响。 */
export function filterArchives(sessions: readonly WorkspaceSession[], filter: ArchiveFilter): WorkspaceSession[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return sessions.filter((session) => session.kind === 'work' && session.archivedAt !== null
    && (filter.workspaceId === ALL_WORKSPACES || session.workspaceId === filter.workspaceId)
    && (!query || session.title.toLocaleLowerCase().includes(query)))
    .sort((a, b) => Date.parse(b.archivedAt!) - Date.parse(a.archivedAt!));
}

/** 使用真实工作区 id；“最近”等逻辑集合没有唯一归属，打开全部归档。 */
export function archiveWorkspaceFilter(workspaces: readonly Workspace[], workspaceId: string): string {
  return workspaces.some((workspace) => workspace.workspaceId === workspaceId) ? workspaceId : ALL_WORKSPACES;
}

export function projectFilterOptions(workspaces: readonly Workspace[]): Array<{ value: string; label: string }> | null {
  if (!workspaces.some((workspace) => workspace.project)) return null;
  return [{ value: ALL_WORKSPACES, label: '全部项目' }, ...workspaces.map((workspace) => ({
    value: workspace.workspaceId, label: workspace.name,
  }))];
}
