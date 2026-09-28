import { lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TempDirectoryUsage, TempRetentionDays } from '@multivac/contracts';
import type { SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import type { ProjectRepository } from '../modules/projects/project.js';
import {
  isCleanupDue,
  type TempCleanupReason,
  type TempDirectoryCleanupPlan,
  type TempDirectoryCleanupRepository,
} from '../modules/sessions/temp-directory-cleanup.js';
import { measureDirectoryUsage } from '../modules/sessions/directory-usage.js';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';
import type { Trash } from '../storage/trash.js';

/** 定时检查的间隔：清理只在服务运行时进行，启动时先补做一次。 */
export const TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface TempCleanupSweepResult {
  /** 移到废纸篓的目录。 */
  trashed: Array<{ path: string; trashPath: string; sessionId: string; reason: TempCleanupReason }>;
  /** 到期时已经是空目录，直接删除。 */
  removed: string[];
  /** 核对后不再清理的计划（会话已恢复或记录已变化、目录已不存在、不在临时目录根下或与受保护目录重叠）。 */
  cancelled: string[];
  /** 本次没能清理、留待下次检查的目录。 */
  failed: Array<{ path: string; error: string }>;
}

export interface TempDirectoryCleanerOptions {
  plans: TempDirectoryCleanupRepository;
  registry: SessionRegistryRepository;
  /** 项目目录（托管与挂载）永不清理：与之重叠的临时目录一律跳过。 */
  projects: Pick<ProjectRepository, 'list'>;
  paths: MultivacWorkPaths;
  /** 内部数据目录同样受保护。 */
  dataDir: string;
  trash: Trash;
  /** 当前偏好中的保留天数；每次检查时读取，修改偏好对已排期的目录同样生效。 */
  retentionDays: () => TempRetentionDays;
  /** 会话此刻是否有运行时：有时它可能正在被恢复或访问，本次不动它的目录，下次再核对。 */
  hasRuntime: (sessionId: string) => boolean;
  now?: () => number;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * 会话临时目录的到期清理：按计划与当前偏好判断到期，到期的目录移到废纸篓（空目录直接删除）。
 *
 * 安全规则：
 * - 清理前与会话记录再核对一次：归档的会话必须仍是已归档、工作目录仍是这个临时目录，且此刻没有运行时；
 *   归入项目后留下的目录必须仍不被任何会话记录引用。不满足时取消计划（有运行时则留待下次）。
 * - 只清理记录类型为临时目录、且（按字面路径与真实路径）直接位于 `<工作根>/sessions/` 下的真实目录；
 *   与 Multivac 工作目录、托管项目根目录、任何项目目录或内部数据目录重叠时一律不动。
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
    const verdict = this.verify(plan);
    if (verdict === 'later') return;
    const refusal = verdict === 'clean' ? this.guard(plan.path) : verdict;
    if (refusal) {
      this.options.plans.remove(plan.path);
      result.cancelled.push(plan.path);
      if (refusal !== 'cancelled' && refusal !== 'missing') this.log(`临时目录不自动清理（${refusal}）：${plan.path}`);
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

  /** 与会话记录再核对一次：clean 可以清理，cancelled 取消计划，later 本次跳过。 */
  private verify(plan: TempDirectoryCleanupPlan): 'clean' | 'cancelled' | 'later' {
    if (plan.directoryKind !== 'session-temp') return 'cancelled';
    if (plan.reason === 'orphaned') {
      return this.options.registry.isWorkingDirectoryRecorded(plan.path) ? 'cancelled' : 'clean';
    }
    const record = this.options.registry.get(plan.sessionId);
    const directory = record?.workingDirectory;
    if (!record || record.kind !== 'work' || record.archivedAt === null ||
        directory?.kind !== 'session-temp' || resolve(directory.path) !== resolve(plan.path)) return 'cancelled';
    return this.options.hasRuntime(plan.sessionId) ? 'later' : 'clean';
  }

  /**
   * 路径防护：返回不能清理的原因，可以清理时返回 null。
   * 必须是直接位于 `sessions/` 下的真实目录（不是符号链接），字面路径与真实路径都要满足，
   * 且与受保护的目录（Multivac 工作目录、托管项目根目录、全部项目目录、内部数据目录）互不包含。
   */
  private guard(path: string): string | null {
    const { paths } = this.options;
    const target = resolve(path);
    if (dirname(target) !== resolve(paths.sessionsDir)) return '不在临时目录根下';
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return 'missing';
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return '不是目录';
    const realTarget = realpathSync.native(target);
    if (dirname(realTarget) !== realpathSync.native(paths.sessionsDir)) return '真实路径不在临时目录根下';

    const protectedPaths = [
      paths.multivacDir,
      paths.projectsDir,
      this.options.dataDir,
      ...this.options.projects.list().flatMap((project) => project.directories.map((directory) => directory.path)),
    ];
    for (const protectedPath of protectedPaths) {
      const literal = resolve(protectedPath);
      if (isPathWithin(literal, target) || isPathWithin(target, literal)) return '与受保护的目录重叠';
      let real: string;
      try {
        real = realpathSync.native(literal);
      } catch {
        continue;
      }
      if (isPathWithin(real, realTarget) || isPathWithin(realTarget, real)) return '与受保护的目录重叠';
    }
    return null;
  }
}
