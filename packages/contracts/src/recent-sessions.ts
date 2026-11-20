import type { ProjectTerminal } from './terminal.js';
import type { WorkspaceSession } from './workspace-session.js';

/** 最近是逻辑集合，对象保留各自真实归属。 */
export const RECENT_WORKSPACE_ID = 'recent';
export const RECENT_DAY_OPTIONS = [0, 1, 3, 7, 14] as const;
export type RecentDays = typeof RECENT_DAY_OPTIONS[number];
export const DEFAULT_RECENT_DAYS = 7;

/** 创建、真实发送及运行事件计入工作活动；查看与元数据编辑不会刷新窗口。 */
export function recentSessions<T extends Pick<WorkspaceSession, 'archivedAt' | 'createdAt' | 'lastActivityAt'>>(
  sessions: readonly T[], days: number, now = Date.now(),
): T[] {
  if (!days) return [];
  const activity = (session: T) => Date.parse(session.lastActivityAt ?? session.createdAt);
  return sessions.filter((session) => session.archivedAt === null && withinRecentWindow(activity(session), days, now))
    .slice().sort((a, b) => activity(b) - activity(a));
}

/** 结束的终端仍可重开，只有关闭才从最近集合移除。 */
export function isRecentTerminal(terminal: Pick<ProjectTerminal, 'closedAt' | 'lastActivityAt'>, days: number, now = Date.now()): boolean {
  return terminal.closedAt === null && withinRecentWindow(Date.parse(terminal.lastActivityAt), days, now);
}

function withinRecentWindow(activity: number, days: number, now: number): boolean {
  return days > 0 && activity >= now - days * 86_400_000 && activity <= now;
}
