import { ListChecks } from 'lucide-react';
import type { TaskRelationSummary } from '@multivac/contracts';

/** 子任务完成进度标签：界面只显示紧凑计数，完整含义放在提示与无障碍名称中。 */
export function TaskChildProgress({ progress }: { progress: TaskRelationSummary['children'] | undefined }) {
  if (!progress?.total) return null;
  const label = `子任务已完成 ${progress.done} / ${progress.total}${progress.cancelled > 0 ? ` · 已取消 ${progress.cancelled}` : ''}`;

  return <span className={`task-child-progress ${progress.done === progress.total ? 'done' : ''}`} role="img" aria-label={label} title={label}>
    <ListChecks aria-hidden="true" />{progress.done}/{progress.total}
  </span>;
}
