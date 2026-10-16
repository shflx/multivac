import type { Task, TaskRun } from '@multivac/contracts';

export const NO_PROGRESS_MS = 5 * 60 * 1000;
// 五分钟只提示；更长的静默窗口才请求暂停。持续输出及工具等待不计入静默。
export const REQUEST_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function requestIdleTimeout(run: TaskRun, now: number, timeoutMs: number): TaskRun['requestTimeout'] {
  if (run.status !== 'running' || run.stopIntent || run.stopConfirmed || run.pendingToolIds.length || run.nativePendingIds?.length) return;
  const started = Date.parse(run.requestStartedAt ?? run.startedAt ?? run.createdAt);
  const activity = run.lastActivityAt ? Date.parse(run.lastActivityAt) : started;
  const since = Math.max(started, activity);
  if (!Number.isFinite(since) || now - since < timeoutMs) return;
  return { at: new Date(now).toISOString(), phase: run.lastActivityAt && activity >= started ? 'response-idle' : 'first-response', idleMs: now - since };
}
/** 没有在途工具且五分钟无执行事件才提示疑似无进展，绝不推导停止事实。 */
export function noProgressSince(task: Task, run: TaskRun, now: number): string | null {
  if (task.status !== 'running' || task.pauseSource || run.status !== 'running' || run.stopIntent || run.stopConfirmed
    || run.pendingToolIds.length || run.nativePendingIds?.length) return null;
  const at = run.lastActivityAt ?? run.requestStartedAt ?? run.startedAt ?? run.createdAt;
  const time = Date.parse(at);
  return Number.isFinite(time) && now - time >= NO_PROGRESS_MS ? at : null;
}
