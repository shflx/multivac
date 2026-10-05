import { DEFAULT_TASK_BUDGET_MILLIS, TASK_BUDGET_MILLIS_OPTIONS, type TaskBudgetMillis } from '@multivac/contracts';

/**
 * 任务执行预算的文案与档位，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：
 * - 预算挂在根任务上，整棵任务树共享：父任务、子任务与历次重试一起消耗同一份额度；
 * - 只有“执行时长”可在“设置 · 偏好”里调整，运行次数与输出字节沿用固定默认值；
 * - 时长按真实时钟累加，包含工具执行与等待授权等时间，运行中的执行在累计超过上限时被安全停止；
 * - 偏好只作用于之后新建的任务，已创建的任务保留创建时的预算。
 */

/** 偏好页“任务执行时长”的选项；默认 6 小时。 */
export const TASK_BUDGET_MILLIS_CHOICES: ReadonlyArray<{ value: TaskBudgetMillis; label: string }> =
  TASK_BUDGET_MILLIS_OPTIONS.map((value) => ({ value, label: taskBudgetMillisLabel(value) }));

/** 档位文案：不足 1 小时按分钟，整小时按小时。 */
export function taskBudgetMillisLabel(millis: TaskBudgetMillis): string {
  const minutes = Math.round(millis / 60_000);
  return minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`;
}

/** 下拉框取值：档位本身是不可变的数字集合，非法值回退到默认档。 */
export function taskBudgetMillisFromOption(value: string): TaskBudgetMillis {
  const millis = Number(value);
  return TASK_BUDGET_MILLIS_OPTIONS.find((option) => option === millis) ?? DEFAULT_TASK_BUDGET_MILLIS;
}

/** 行内说明：时长如何累积、作用范围与已创建任务的边界。 */
export function taskBudgetHint(): string {
  return '任务树共享这一份时长，父子任务与重试一起消耗；按真实时间累加，包含工具执行与等待。'
    + '只作用于之后新建的任务，已创建的任务保留创建时的预算；超过上限会安全停止当前执行。';
}
