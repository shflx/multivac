import type { TempRetentionDays } from '@multivac/contracts';

/**
 * 会话临时目录的清理计划。
 *
 * 只有两种来源，都只针对临时目录（`session-temp`）：
 * - archived：会话归档时临时目录里有文件，从归档时间起计时；到期前恢复会话则取消；
 * - orphaned：会话归入项目后原临时目录里仍有文件（没选移入或同名未移入），已不被任何会话记录引用，
 *   从归入时间起计时。
 *
 * 计划只记录“从何时起计时”，不记录到期时间：到期时间 = 起算时间 + 当前偏好中的保留天数，
 * 每次检查时按当前偏好计算，所以修改保留时长对已排期的目录同样生效；偏好为“从不”时不清理。
 */
export type TempCleanupReason = 'archived' | 'orphaned';

export interface TempDirectoryCleanupPlan {
  /** 临时目录的绝对路径，计划的主键。 */
  path: string;
  /** 记录中的目录类型；只接受临时目录，其他类型永不自动清理。 */
  directoryKind: 'session-temp';
  reason: TempCleanupReason;
  /** 归档的会话，或归入项目前使用这个目录的会话。 */
  sessionId: string;
  /** 起算时间：归档时间或归入时间（ISO）。 */
  since: string;
  /** 已移到废纸篓的时间与位置（只为归档的会话保留，恢复时据此提示）；待清理时为 null。 */
  trashedAt: string | null;
  trashPath: string | null;
}

export interface NewTempDirectoryCleanupPlan {
  path: string;
  reason: TempCleanupReason;
  sessionId: string;
  since: string;
}

export interface TempDirectoryCleanupRepository {
  /** 登记（或按同一路径替换）一条待清理的计划。 */
  schedule(plan: NewTempDirectoryCleanupPlan): void;
  get(path: string): TempDirectoryCleanupPlan | undefined;
  /** 待清理（尚未移到废纸篓）的计划，按起算时间升序。 */
  listPending(): TempDirectoryCleanupPlan[];
  markTrashed(path: string, trashedAt: string, trashPath: string): void;
  remove(path: string): void;
  /** 删除全部计划，仅供 Fake E2E 在用例之间恢复初始状态。 */
  clearForTest(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 到期时间（毫秒时间戳）；保留时长为“从不”或起算时间无法解析时为 null（不清理）。 */
export function cleanupDueAt(since: string, retentionDays: TempRetentionDays): number | null {
  if (retentionDays === null) return null;
  const start = Date.parse(since);
  return Number.isNaN(start) ? null : start + retentionDays * DAY_MS;
}

/** 按当前偏好，计划在 now 时是否已到期。 */
export function isCleanupDue(since: string, retentionDays: TempRetentionDays, now: number): boolean {
  const due = cleanupDueAt(since, retentionDays);
  return due !== null && due <= now;
}
