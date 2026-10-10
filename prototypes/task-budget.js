/**
 * 任务执行预算的档位与文案，与 dev 的 task-budget 保持一致。
 *
 * 预算挂在根任务上，整棵任务树共享；偏好只作用于新建任务和主动继续时补充的额度，
 * 修改偏好不改变已有任务的额度。原型只模拟文案与“额度用完暂停”的示例状态。
 */

/** 可选档位：30 分钟、2 小时、6 小时、24 小时；默认 6 小时。 */
export const TASK_BUDGET_MILLIS_OPTIONS = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const DEFAULT_TASK_BUDGET_MILLIS = 6 * 3_600_000;

/** 档位文案：不足 1 小时按分钟，整小时按小时。 */
export function taskBudgetMillisLabel(millis) {
  const minutes = Math.round(millis / 60_000);
  return minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`;
}

export const TASK_BUDGET_MILLIS_CHOICES = TASK_BUDGET_MILLIS_OPTIONS.map((value) => ({ value, label: taskBudgetMillisLabel(value) }));

/** 下拉框取值：非法值回退到默认档。 */
export function taskBudgetMillisFromOption(value) {
  const millis = Number(value);
  return TASK_BUDGET_MILLIS_OPTIONS.find((option) => option === millis) ?? DEFAULT_TASK_BUDGET_MILLIS;
}

export function taskBudgetHint() {
  return '任务树共享这一份时长，父子任务与重试一起消耗；按真实时间累加，包含工具执行与等待。'
    + '用于新建任务和点击“继续任务”时补充的额度；修改偏好不会直接改变已有任务的额度。额度用完会暂停，继续时补充额度，已有工作和历史记录保留。';
}

/** 继续前的额度说明：只给可继续的 Agent 任务；有父任务时补充共享说明。 */
export function resumeBudgetHint(task) {
  if (task.humanOnly || task.status !== 'paused') return '';
  return `继续任务会按当前偏好补充执行额度，已有工作和历史记录保留。${task.parentTaskId ? '父子任务共享补充后的额度。' : ''}`;
}
