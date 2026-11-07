import type { SubagentStatus } from '@multivac/contracts';

export const SUBAGENT_STATES: Record<SubagentStatus, string> = { preparing: '准备中', running: '执行中', stopping: '停止中', succeeded: '已完成', failed: '失败', cancelled: '已取消', exhausted: '额度耗尽', interrupted: '已中断', reconcile: '待核对' };

/** 一分钟内按秒，其余按分钟。 */
export const formatElapsed = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`;
