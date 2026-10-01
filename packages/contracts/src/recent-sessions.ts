import type { WorkspaceSession } from './workspace-session.js';

/** 逻辑集合只借用会话身份，既不是项目，也不是会话的真实归属。 */
export const RECENT_WORKSPACE_ID = 'recent';
export const RECENT_DAY_OPTIONS = [0, 1, 3, 7, 14] as const;
export type RecentDays = typeof RECENT_DAY_OPTIONS[number];
export const DEFAULT_RECENT_DAYS = 7;

/** 创建、真实发送及运行事件计入工作活动；查看与元数据编辑不会刷新窗口。 */
export function recentSessions<T extends Pick<WorkspaceSession, 'archivedAt' | 'createdAt' | 'lastActivityAt'>>(
  sessions: readonly T[], days: number, now = Date.now(),
): T[] {
  if (!days) return [];
  const cutoff = now - days * 86_400_000;
  const activity = (session: T) => Date.parse(session.lastActivityAt ?? session.createdAt);
  return sessions.filter((session) => session.archivedAt === null && activity(session) >= cutoff && activity(session) <= now)
    .slice().sort((a, b) => activity(b) - activity(a));
}
