import { readdirSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TempDirectoryUsage, TempRetentionDays } from '@multivac/contracts';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import {
  isCleanupDue,
  type TempCleanupReason,
  type TempDirectoryCleanupPlan,
  type TempDirectoryCleanupRepository,
} from '../modules/sessions/temp-directory-cleanup.js';
import { measureDirectoryUsage } from '../modules/sessions/directory-usage.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';
import type { Trash } from '../storage/trash.js';
import type { TempDirectoryRemovalPolicy } from './temp-directory-removal.js';

/** 定时检查的间隔：清理只在服务运行时进行，启动时先补做一次。 */
export const TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface TempCleanupSweepResult {
  /** 移到废纸篓的目录。 */
  trashed: Array<{ path: string; trashPath: string; sessionId: string; reason: TempCleanupReason }>;
  /** 到期时已经是空目录，直接删除。 */
  removed: string[];
  /** 核对后不再清理的计划（会话已恢复或记录已变化、目录已不存在、不在临时目录根下、与受保护目录重叠或仍被其他会话使用）。 */
  cancelled: string[];
  /** 本次没能清理、留待下次检查的目录。 */
  failed: Array<{ path: string; error: string }>;
}

export interface TempDirectoryCleanerOptions {
  plans: TempDirectoryCleanupRepository;
  registry: SessionRegistryRepository;
  /** 能否移除临时目录的统一判定（位置、受保护的目录、其他会话的引用与运行时），与归档时删除空目录共用。 */
  removal: TempDirectoryRemovalPolicy;
  /** 统计占用的 `sessions/` 位置。 */
  paths: MultivacWorkPaths;
  trash: Trash;
  /** 当前偏好中的保留天数；每次检查时读取，修改偏好对已排期的目录同样生效。 */
  retentionDays: () => TempRetentionDays;
  now?: () => number;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * 会话临时目录的到期清理：按计划与当前偏好判断到期，到期的目录移到废纸篓（空目录直接删除）。
 *
 * 安全规则：
 * - 清理前与会话记录再核对一次：归档的会话必须仍是已归档、工作目录仍是这个临时目录；不满足时取消计划。
 * - 再经 `TempDirectoryRemovalPolicy` 判定：只清理直接位于 `<工作根>/sessions/` 下的真实目录，
 *   与受保护的目录（Multivac 工作目录、托管项目根目录、任何项目目录、内部数据目录）重叠、
 *   或仍被其他任何会话记录（含已归档的）引用时取消计划；所属会话此刻有运行时则留待下次。
 * - 核对与移动在同一个同步段内完成，恢复会话（同样是同步的）不会与之交错；
 *   恢复先经 `SessionWorkingDirectories.reopen` 取消计划，之后的检查就不会再看到它。
 */
export class TempDirectoryCleaner {
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private clockOffsetMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private measuring: Promise<TempDirectoryUsage> | null = null;

  constructor(private readonly options: TempDirectoryCleanerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** 启动时补做一次到期检查，之后定时检查；定时器不阻止进程退出。 */
  start(): void {
    this.sweepSafely();
    if (this.timer) return;
    this.timer = setInterval(() => this.sweepSafely(), this.options.intervalMs ?? TEMP_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  /** 定时与偏好变化触发的检查：意外错误只记录，不影响服务与触发它的请求，下次检查时重试。 */
  sweepSafely(): void {
    try {
      this.sweep();
    } catch (error) {
      this.log(`临时目录到期检查失败，下次检查时重试：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 检查全部待清理的计划，到期的按规则清理；每个目录独立处理，一个失败不影响其他。 */
  sweep(): TempCleanupSweepResult {
    const result: TempCleanupSweepResult = { trashed: [], removed: [], cancelled: [], failed: [] };
    const retention = this.options.retentionDays();
    if (retention === null) return result;
    const now = this.currentTime();
    for (const plan of this.options.plans.listPending()) {
      if (!isCleanupDue(plan.since, retention, now)) continue;
      try {
        this.clean(plan, new Date(now).toISOString(), result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failed.push({ path: plan.path, error: message });
        this.log(`临时目录到期清理失败，下次检查时重试：${plan.path}：${message}`);
      }
    }
    return result;
  }

  /** 临时目录的总占用；同时到达的请求共用一次统计。 */
  usage(): Promise<TempDirectoryUsage> {
    if (!this.measuring) {
      this.measuring = measureDirectoryUsage(this.options.paths.sessionsDir)
        .then((usage) => ({ ...usage, measuredAt: new Date(this.currentTime()).toISOString() }))
        .finally(() => { this.measuring = null; });
    }
    return this.measuring;
  }

  /** 仅供 Fake E2E：把清理用的时钟向后拨，模拟保留期满。 */
  advanceClockForTest(ms: number): void {
    this.clockOffsetMs += ms;
  }

  resetForTest(): void {
    this.clockOffsetMs = 0;
    this.options.plans.clearForTest();
  }

  private currentTime(): number {
    return this.now() + this.clockOffsetMs;
  }

  private clean(plan: TempDirectoryCleanupPlan, at: string, result: TempCleanupSweepResult): void {
    const owner = this.owner(plan);
    const removal = owner === undefined ? { verdict: 'cancelled' as const } : this.options.removal.check(plan.path, owner);
    if (removal.verdict === 'later') return;
    if (removal.verdict !== 'allowed') {
      this.options.plans.remove(plan.path);
      result.cancelled.push(plan.path);
      if (removal.verdict === 'refused') this.log(`临时目录不自动清理（${removal.reason}）：${plan.path}`);
      return;
    }

    if (readdirSync(plan.path).length === 0) {
      rmdirSync(plan.path);
      this.options.plans.remove(plan.path);
      result.removed.push(plan.path);
      return;
    }
    const trashPath = this.options.trash.moveToTrash(plan.path);
    // 归档的会话保留记录，恢复时据此说明目录已移到废纸篓；归入项目后留下的目录没有会话再用，直接结束。
    if (plan.reason === 'archived') this.options.plans.markTrashed(plan.path, at, trashPath);
    else this.options.plans.remove(plan.path);
    result.trashed.push({ path: plan.path, trashPath, sessionId: plan.sessionId, reason: plan.reason });
  }

  /**
   * 与会话记录再核对计划的归属：归档的计划返回所属会话（它必须仍是已归档的工作会话、工作目录仍是这个临时目录），
   * 孤立目录没有所属会话，返回 null；核对不通过时返回 undefined（取消计划）。
   */
  private owner(plan: TempDirectoryCleanupPlan): string | null | undefined {
    if (plan.directoryKind !== 'session-temp') return undefined;
    if (plan.reason === 'orphaned') return null;
    const record = this.options.registry.get(plan.sessionId);
    const directory = record?.workingDirectory;
    if (!record || record.kind !== 'work' || record.archivedAt === null ||
        directory?.kind !== 'session-temp' || resolve(directory.path) !== resolve(plan.path)) return undefined;
    return record.sessionId;
  }
}
