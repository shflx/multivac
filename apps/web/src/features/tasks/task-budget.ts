import { DEFAULT_TASK_BUDGET_MILLIS, TASK_BUDGET_MILLIS_OPTIONS, type TaskBudgetMillis } from '@multivac/contracts';

/**
 * 任务执行预算的文案与档位，与界面无关，便于单独测试。
 *
 * 规则（与服务端一致）：
 * - 预算挂在根任务上，整棵任务树共享：父任务、子任务与历次重试一起消耗同一份额度；
 * - 只有“执行时长”可在“设置 · 偏好”里调整，运行次数与输出字节沿用固定默认值；
 * - 时长按真实时钟累加，包含工具执行与等待授权等时间，运行中的执行在累计超过上限时被安全停止；
 * - 偏好作用于新建任务与用户主动继续时补充的额度，修改偏好本身不改变已有任务的额度。
 * - 用户主动继续会重置整棵任务树的可用额度，历史消耗保留；人工请求后的自动恢复不重置额度。
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
  return '任务树共享这一份时长，父子任务与重试一起消耗。';
}

/** 行说明的展开部分：累计口径、作用范围与额度用完后的处理。 */
export function taskBudgetDetails(): string {
  return '按真实时间累加，包含工具执行与等待。用于新建任务和点击“继续任务”时补充的额度；'
    + '修改偏好不会直接改变已有任务的额度。额度用完会暂停，继续时补充额度，已有工作和历史记录保留。';
}
