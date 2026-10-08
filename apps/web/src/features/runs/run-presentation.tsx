import { CircleAlert, Clock3, LoaderCircle, Pause } from 'lucide-react';
import { RUN_STATE_LABELS, type RunSnapshot, type RunsSnapshot } from '@multivac/contracts';

export const activeRunStates = new Set<RunSnapshot['state']>(['preparing', 'running', 'stopping']);

/** 顶栏只概括非零的运行事实，等待用户的事项继续由 Inbox 呈现。 */
export function runSummary(counts: RunsSnapshot['counts']): string {
  const parts = [
    [counts.running, '个执行中'], [counts.queued, '个排队'], [counts.anomalies, '个异常'],
    [counts.processesRunning ?? 0, '个后台进程'], [counts.processesRecovery ?? 0, '个进程待核对'],
  ] as const;
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`).join(' · ') || '没有执行中或排队的任务';
}

export function runStateLabel(item: RunSnapshot): string {
  return item.anomaly && item.state === 'running' ? '疑似无进展' : RUN_STATE_LABELS[item.state];
}

export function RunStateBadge({ item }: { item: RunSnapshot }) {
  const Icon = item.anomaly ? CircleAlert : activeRunStates.has(item.state) ? LoaderCircle : item.state === 'paused' ? Pause : Clock3;
  return <span className={`run-state-badge ${item.anomaly ? 'attention' : activeRunStates.has(item.state) ? 'running' : 'idle'}`}>
    <Icon className={!item.anomaly && activeRunStates.has(item.state) ? 'spin' : undefined} aria-hidden="true" />{runStateLabel(item)}
  </span>;
}

export function durationLabel(millis: number): string {
  if (!Number.isFinite(millis)) return '未知';
  const seconds = Math.max(0, Math.floor(millis / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${Math.floor(seconds / 3600)} 小时${minutes ? ` ${minutes} 分钟` : ''}`;
}

export function recentToolAge(at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (!Number.isFinite(elapsed)) return '';
  if (elapsed < 60000) return '刚刚';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
  return `${Math.floor(elapsed / 3600000)} 小时前`;
}
