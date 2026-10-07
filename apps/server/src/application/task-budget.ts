import type { TaskBudget, TaskRun } from '@multivac/contracts';

export interface TaskBudgetUsage { runs: number; millis: number; bytes: number }

/** 所有历史消耗继续保留；未开始的排队记录不占用执行额度。 */
export function taskBudgetUsage(runs: readonly TaskRun[], now: number): TaskBudgetUsage {
  return runs.filter(run => run.hasStarted !== false).reduce((usage, run) => ({
    runs: usage.runs + 1,
    millis: usage.millis + (run.stopConfirmed ? run.elapsedMs ?? 0 : Math.max(0, now - Date.parse(run.startedAt ?? run.createdAt))),
    bytes: usage.bytes + (run.outputBytes ?? 0),
  }), { runs: 0, millis: 0, bytes: 0 });
}

/** 继续时保存消耗检查点，后续只扣除检查点之后的消耗，整棵任务树仍共享额度。 */
export function taskBudgetBalance(runs: readonly TaskRun[], initialLimit: TaskBudget, now: number) {
  const renewal = runs.findLast(run => run.budgetRenewal)?.budgetRenewal;
  // 根任务预算后来被显式调整时优先采用新值，避免继续检查点覆盖用户的修改。
  const unchanged = renewal && initialLimit.maxRuns === renewal.previousLimit.maxRuns && initialLimit.maxMillis === renewal.previousLimit.maxMillis && initialLimit.maxOutputBytes === renewal.previousLimit.maxOutputBytes;
  const limit = unchanged ? renewal.limit : initialLimit;
  const total = taskBudgetUsage(runs, now);
  const used = {
    runs: Math.max(0, total.runs - (renewal?.used.runs ?? 0)),
    millis: Math.max(0, total.millis - (renewal?.used.millis ?? 0)),
    bytes: Math.max(0, total.bytes - (renewal?.used.bytes ?? 0)),
  };
  return { limit, used, remainingRuns: limit.maxRuns - used.runs, remainingMillis: limit.maxMillis - used.millis, remainingBytes: limit.maxOutputBytes - used.bytes };
}

function duration(millis: number): string {
  const seconds = Math.ceil(millis / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', rest || !seconds ? `${rest} 秒` : ''].filter(Boolean).join(' ');
}
function bytes(value: number): string { return value < 1024 ? `${value} 字节` : value < 1024 * 1024 ? `${Number((value / 1024).toFixed(1))} KiB` : `${Number((value / 1024 / 1024).toFixed(1))} MiB`; }

export function taskBudgetExhaustion(balance: ReturnType<typeof taskBudgetBalance>, queued = false): string {
  const reasons: string[] = [];
  if (balance.remainingMillis <= 0) reasons.push(`执行时间已用完（已用 ${duration(balance.used.millis)}，上限 ${duration(balance.limit.maxMillis)}）`);
  if (balance.remainingBytes <= 0) reasons.push(`读写和输出额度已用完（已用 ${bytes(balance.used.bytes)}，上限 ${bytes(balance.limit.maxOutputBytes)}）`);
  if (queued && balance.remainingRuns < 1) reasons.push(`执行次数已用完（已用 ${balance.used.runs} 次，上限 ${balance.limit.maxRuns} 次）`);
  return reasons.join('；') || '本次执行额度已用完';
}
