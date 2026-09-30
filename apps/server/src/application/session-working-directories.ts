import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Project, WorkingDirectory } from '@multivac/contracts';
import type { SessionRecord, SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import { firstAvailableName, isPathWithin, sessionTempDirectoryName } from '../modules/sessions/working-directory.js';
import type { TempDirectoryCleanupRepository } from '../modules/sessions/temp-directory-cleanup.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';
import { TempDirectoryRemovalPolicy } from './temp-directory-removal.js';

/**
 * 由 Multivac 在工作文件根目录中创建与维护的目录类型（被删除时补建）；
 * 项目挂载目录属于用户，不由这里创建。
 */
const OWNED_KINDS: ReadonlySet<WorkingDirectory['kind']> = new Set(['session-temp', 'multivac', 'project-managed']);

/** 恢复会话时工作目录的情况：临时目录在归档期间已到期移到废纸篓时，写明何时移走、移到了哪里。 */
export interface ReopenedWorkingDirectory {
  directory: WorkingDirectory;
  trashedDirectory: { trashedAt: string; trashPath: string } | null;
}

/** 工作目录此刻不能使用（不存在、不是目录、建不出来或位于内部数据目录之下）；消息写明原因与路径，可以直接给人看。 */
export class WorkingDirectoryUnavailableError extends Error {
  constructor(reason: string, readonly path: string) {
    super(`${reason}：${path}`);
    this.name = 'WorkingDirectoryUnavailableError';
  }
}

/** 临时目录的生命周期：清理计划的存储、能否移除临时目录的判定与起算时间使用的时钟。 */
export interface TempDirectoryLifecycleOptions {
  plans: TempDirectoryCleanupRepository;
  /**
   * 与到期清理共用的判定（受保护的目录、其他会话的引用、运行时）。
   * 未提供时只按位置与会话记录判定（不知道项目目录与运行时），仅供不涉及项目的测试使用。
   */
  removal?: TempDirectoryRemovalPolicy;
  now?: () => string;
}

/**
 * 会话工作目录的分配、创建与存量迁移，以及临时目录生命周期中与会话记录相关的部分
 * （归档时删除空目录或登记清理、恢复时取消清理、归入项目后留下的目录登记清理）；
 * 到期检查与移到废纸篓由 `TempDirectoryCleaner` 执行。
 *
 * 会话记录是工作目录的唯一权威来源：新建会话时先分配路径并随记录一起写入，
 * 记录写入成功后才创建目录，客户端 id 幂等重放不会再建第二个目录。
 */
export class SessionWorkingDirectories {
  private readonly now: () => string;
  private readonly removal: TempDirectoryRemovalPolicy;

  constructor(
    private readonly paths: MultivacWorkPaths,
    private readonly registry: SessionRegistryRepository,
    /** 内部数据目录：任何会话的工作目录都不得位于其中。 */
    private readonly dataDir: string,
    /** 未提供时不登记清理计划（归档时仍按判定删除空的临时目录）。 */
    private readonly lifecycle?: TempDirectoryLifecycleOptions,
  ) {
    this.now = lifecycle?.now ?? (() => new Date().toISOString());
    this.removal = lifecycle?.removal ?? new TempDirectoryRemovalPolicy({
      registry, projects: { list: () => [] }, paths, dataDir, hasRuntime: () => false,
    });
  }

  /** 全局 Multivac 的工作目录：工作文件根目录下的 `multivac/`，长期保留。 */
  multivac(): WorkingDirectory {
    return { kind: 'multivac', path: this.paths.multivacDir };
  }

  /**
   * 为工作会话分配临时目录路径（不创建）：`sessions/<本地日期>-<会话名>-<短 id>/`。
   * 目录名已存在于磁盘或已被其他会话记录使用时依次追加 `-2`、`-3`……
   */
  allocateSessionTemp(input: { sessionId: string; title: string; createdAt: string }): WorkingDirectory {
    const name = firstAvailableName(sessionTempDirectoryName(input), (candidate) => {
      const path = join(this.paths.sessionsDir, candidate);
      return existsSync(path) || this.registry.isWorkingDirectoryRecorded(path);
    });
    return { kind: 'session-temp', path: join(this.paths.sessionsDir, name) };
  }

  /**
   * 新会话的工作目录（只分配路径，不创建）：所在工作区属于项目时，使用项目的主目录，
   * 同一项目的会话共用这个目录；不属于项目时，分配会话自己的临时目录。
   */
  allocateForNewSession(
    project: Project | null,
    input: { sessionId: string; title: string; createdAt: string },
  ): WorkingDirectory {
    return project ? this.forProject(project) : this.allocateSessionTemp(input);
  }

  /** 项目中会话的工作目录：项目的主目录（托管或挂载），同一项目的会话共用。 */
  forProject(project: Project): WorkingDirectory {
    const primary = project.directories[0];
    if (!primary) throw new Error(`项目 ${project.projectId} 没有目录。`);
    return { kind: primary.kind === 'managed' ? 'project-managed' : 'project-mounted', path: primary.path };
  }

  /** 确保 Multivac 维护的工作目录存在；项目挂载目录等用户目录不在这里创建。 */
  ensure(directory: WorkingDirectory): void {
    if (OWNED_KINDS.has(directory.kind)) mkdirSync(directory.path, { recursive: true });
  }

  /**
   * 启动会话运行时（新建或恢复 Pi 会话）前调用：每次都从会话记录读取工作目录，
   * 确保目录存在（用户可能手动删除，已归档会话只记录了路径），返回记录中的工作目录（类型 + 路径）。
   *
   * 记录缺失、目录不存在且不由 Multivac 创建、或实际位于内部数据目录之下时抛错，运行时不启动。
   */
  resolveForRuntime(sessionId: string): WorkingDirectory {
    const directory = this.registry.get(sessionId)?.workingDirectory;
    if (!directory || !isAbsolute(directory.path)) {
      throw new Error(`会话 ${sessionId} 没有有效的工作目录记录。`);
    }
    this.prepare(directory);
    return { ...directory };
  }

  /**
   * 确认目录可以作为会话的工作目录：Multivac 维护的目录按需补建，挂载目录必须已存在；
   * 必须是目录，且（按字面路径与真实路径）不在内部数据目录之下。
   * 不可用时抛出 `WorkingDirectoryUnavailableError`，写明原因与路径。
   * 运行时启动前、恢复归档会话前与归入项目前都经过这里。
   */
  prepare(directory: WorkingDirectory): void {
    const unavailable = (reason: string) => new WorkingDirectoryUnavailableError(reason, directory.path);
    // 先按字面路径校验，冲突时不在内部数据目录中建目录；创建后再按真实路径复核符号链接。
    if (isPathWithin(resolve(this.dataDir), resolve(directory.path))) throw unavailable('工作目录位于内部数据目录之下');
    try {
      this.ensure(directory);
    } catch {
      throw unavailable('无法创建工作目录');
    }
    let isDirectory: boolean;
    try {
      isDirectory = statSync(directory.path).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw unavailable(code === 'ENOENT' || code === 'ENOTDIR' ? '工作目录不存在（可能已被移走或删除）' : '无法访问工作目录');
    }
    if (!isDirectory) throw unavailable('工作目录不是目录');
    if (isPathWithin(realpathSync.native(this.dataDir), realpathSync.native(directory.path))) {
      throw unavailable('工作目录位于内部数据目录之下');
    }
  }

  /**
   * 会话归档后（归档标记已写入）调用，只处理临时目录：
   * - 目录为空（或已不存在）时直接删除，返回 removed；
   * - 仍有文件时保留，并登记清理计划（从归档时间起按偏好计时，到期移到废纸篓），返回 scheduled；
   * - 其他类型（Multivac 工作目录、项目目录）永不自动清理，返回 kept；
   * - 临时目录被挂载为项目目录、或仍被其他会话使用（见 `TempDirectoryRemovalPolicy`）时同样保留，
   *   不删除也不登记，返回 kept。
   */
  archive(record: SessionRecord): 'removed' | 'scheduled' | 'kept' {
    const directory = record.workingDirectory;
    if (directory?.kind !== 'session-temp') return 'kept';
    const removal = this.removal.check(directory.path, record.sessionId);
    if (removal.verdict === 'missing') return 'removed';
    if (removal.verdict === 'refused') return 'kept';
    if (removal.verdict === 'allowed' && removeEmptyDirectory(directory.path)) return 'removed';
    this.lifecycle?.plans.schedule({
      path: directory.path,
      reason: 'archived',
      sessionId: record.sessionId,
      since: record.archivedAt ?? this.now(),
    });
    return 'scheduled';
  }

  /**
   * 恢复已归档会话时、清除归档标记之前调用：沿用记录中的工作目录，按运行时启动前的同一套校验（`prepare`）
   * 确认它可用——Multivac 维护的目录按需补建（存量迁移只为已归档会话记录了路径，归档期间也可能被手动删除
   * 或到期移到废纸篓）；挂载目录不补建，被移走、换成文件或位于内部数据目录之下时不可用——
   * 然后取消这个目录的清理计划。不可用时抛出 `WorkingDirectoryUnavailableError`，计划保留，会话保持归档。
   *
   * 目录已按计划移到废纸篓时，按规则重建空目录，并返回移走的时间与位置供界面说明；
   * 其他原因缺失的目录（归档时为空而删除、手动删除）照常补建，不另作说明。
   */
  reopen(record: SessionRecord): ReopenedWorkingDirectory {
    const directory = record.workingDirectory;
    if (!directory) throw new Error(`会话 ${record.sessionId} 没有工作目录记录。`);
    const plan = directory.kind === 'session-temp' ? this.lifecycle?.plans.get(directory.path) : undefined;
    const missing = !existsSync(directory.path);
    this.prepare(directory);
    if (plan) this.lifecycle?.plans.remove(directory.path);
    return {
      directory,
      trashedDirectory: plan?.trashedAt && plan.trashPath && missing
        ? { trashedAt: plan.trashedAt, trashPath: plan.trashPath }
        : null,
    };
  }

  /**
   * 归入项目后原临时目录仍有文件（没选移入或同名未移入）：它已不被任何会话记录引用，
   * 登记清理计划，从归入时间起按偏好计时，到期移到废纸篓。按统一判定不能移除的（例如它就是项目目录、
   * 仍被其他会话使用）不登记。
   */
  orphan(directory: WorkingDirectory, sessionId: string): void {
    if (directory.kind !== 'session-temp' || !existsSync(directory.path)) return;
    if (this.removal.check(directory.path, null).verdict === 'refused') return;
    this.lifecycle?.plans.schedule({ path: directory.path, reason: 'orphaned', sessionId, since: this.now() });
  }

  /**
   * 这个临时目录归档后会不会按生命周期处理（空时删除、有文件时到期清理）：
   * 不是临时目录，或被挂载为项目目录、仍被其他会话使用等不能移除时为 false。归档前的核对据此说明去留。
   */
  followsLifecycle(record: SessionRecord): boolean {
    const directory = record.workingDirectory;
    return directory?.kind === 'session-temp' && this.removal.check(directory.path, record.sessionId).verdict !== 'refused';
  }

  /**
   * 删除空的临时目录（新建失败的回收、归入项目后不再使用的临时目录），返回是否删除；
   * 目录非空（仍有文件）、不存在、不是临时目录，或按统一判定不能移除（被挂载为项目目录、
   * 仍被其他会话使用等）时保持原样。调用时已没有会话记录以它为临时目录（记录已删除或已改指项目目录）。
   */
  discard(directory: WorkingDirectory): boolean {
    if (directory.kind !== 'session-temp') return false;
    if (this.removal.check(directory.path, null).verdict !== 'allowed') return false;
    return removeEmptyDirectory(directory.path);
  }

  /**
   * 启动时补齐工作目录，可重复执行：
   * - 全局 Multivac 指向当前工作文件根目录下的 `multivac/`（工作文件根目录调整后随之更新）；
   * - 没有工作目录的工作会话（含已归档）按创建日期与名称分配临时目录并写入记录；
   * - 未归档会话的目录不存在时创建；已归档会话只记录路径，恢复时再创建；
   * - 已归档会话的临时目录里有文件、却没有清理计划的（临时目录生命周期上线前归档的），
   *   从这次启动起计时登记，不按当年的归档时间立即清理。
   */
  prepareOnStartup(): void {
    const multivac = this.multivac();
    for (const record of this.registry.listAll()) {
      const directory = this.assign(record, multivac);
      if (record.archivedAt === null) this.ensure(directory);
      else if (record.kind === 'work') this.scheduleUntracked(record.sessionId, directory);
    }
  }

  /**
   * 仅供 Fake E2E 在用例之间恢复空工作区：会话记录已全部删除，清空 `sessions/` 下留下的临时目录，
   * 让临时目录占用与清理从干净的状态开始。只动工作文件根目录下的 `sessions/`。
   */
  clearSessionsForTest(): void {
    rmSync(this.paths.sessionsDir, { recursive: true, force: true });
    mkdirSync(this.paths.sessionsDir, { recursive: true });
  }

  private scheduleUntracked(sessionId: string, directory: WorkingDirectory): void {
    if (!this.lifecycle || directory.kind !== 'session-temp' || this.lifecycle.plans.get(directory.path)) return;
    let entries: string[];
    try {
      entries = readdirSync(directory.path);
    } catch {
      return;
    }
    if (entries.length > 0) {
      this.lifecycle.plans.schedule({ path: directory.path, reason: 'archived', sessionId, since: this.now() });
    }
  }

  private assign(record: SessionRecord, multivac: WorkingDirectory): WorkingDirectory {
    if (record.kind === 'coordinator') {
      if (record.workingDirectory?.kind !== multivac.kind || record.workingDirectory.path !== multivac.path) {
        this.registry.setWorkingDirectory(record.sessionId, multivac);
      }
      return multivac;
    }
    if (record.workingDirectory) return record.workingDirectory;
    const directory = this.allocateSessionTemp(record);
    this.registry.setWorkingDirectory(record.sessionId, directory);
    return directory;
  }
}

/** 只删除空目录（rmdir），返回是否删除；目录非空或不存在时保持原样。 */
function removeEmptyDirectory(path: string): boolean {
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}
