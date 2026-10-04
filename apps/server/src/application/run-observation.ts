import type { Task, TaskRun } from '@multivac/contracts';

export const NO_PROGRESS_MS = 5 * 60 * 1000;
/** 没有在途工具且五分钟无执行事件才提示疑似无进展，绝不推导停止事实。 */
export function noProgressSince(task: Task, run: TaskRun, now: number): string | null {
  if (task.status !== 'running' || task.pauseSource || run.status !== 'running' || run.stopIntent || run.stopConfirmed
    || run.pendingToolIds.length || run.nativePendingIds?.length) return null;
  const at = run.lastActivityAt ?? run.startedAt ?? run.createdAt;
  const time = Date.parse(at);
  return Number.isFinite(time) && now - time >= NO_PROGRESS_MS ? at : null;
}
