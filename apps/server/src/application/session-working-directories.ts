import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Project, WorkingDirectory } from '@multivac/contracts';
import type { SessionRecord, SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import { firstAvailableName, isPathWithin, sessionTempDirectoryName } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';

/**
 * 由 Multivac 在工作文件根目录中创建与维护的目录类型（被删除时补建）；
 * 项目挂载目录属于用户，不由这里创建。
 */
const OWNED_KINDS: ReadonlySet<WorkingDirectory['kind']> = new Set(['session-temp', 'multivac', 'project-managed']);

/**
 * 会话工作目录的分配、创建与存量迁移。
 *
 * 会话记录是工作目录的唯一权威来源：新建会话时先分配路径并随记录一起写入，
 * 记录写入成功后才创建目录，客户端 id 幂等重放不会再建第二个目录。
 */
export class SessionWorkingDirectories {
  constructor(
    private readonly paths: MultivacWorkPaths,
    private readonly registry: SessionRegistryRepository,
    /** 内部数据目录：任何会话的工作目录都不得位于其中。 */
    private readonly dataDir: string,
  ) {}

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
   * 必须是目录，且（按字面路径与真实路径）不在内部数据目录之下。不可用时抛错。
   * 运行时启动前与归入项目前都经过这里。
   */
  prepare(directory: WorkingDirectory): void {
    const insideDataDir = () => new Error(`工作目录位于内部数据目录之下：${directory.path}`);
    // 先按字面路径校验，冲突时不在内部数据目录中建目录；创建后再按真实路径复核符号链接。
    if (isPathWithin(resolve(this.dataDir), resolve(directory.path))) throw insideDataDir();
    this.ensure(directory);
    if (!statSync(directory.path).isDirectory()) {
      throw new Error(`工作目录不是目录：${directory.path}`);
    }
    if (isPathWithin(realpathSync.native(this.dataDir), realpathSync.native(directory.path))) throw insideDataDir();
  }

  /**
   * 恢复已归档会话时、清除归档标记之前调用：沿用记录中的工作目录并确保它存在
   * （存量迁移只为已归档会话记录了路径，归档期间也可能被手动删除）。
   *
   * 归档后的临时目录清理（保留期满移到废纸篓）接入后，先在这里取消该会话待执行的清理，
   * 再补建目录；抛错时会话保持归档。
   */
  reopen(record: SessionRecord): WorkingDirectory {
    const directory = record.workingDirectory;
    if (!directory) throw new Error(`会话 ${record.sessionId} 没有工作目录记录。`);
    this.ensure(directory);
    return directory;
  }

  /**
   * 删除空的临时目录（新建失败的回收、归入项目后不再使用的临时目录），返回是否删除；
   * 目录非空（仍有文件）、不存在或不是临时目录时保持原样。
   */
  discard(directory: WorkingDirectory): boolean {
    if (directory.kind !== 'session-temp') return false;
    try {
      rmdirSync(directory.path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 启动时补齐工作目录，可重复执行：
   * - 全局 Multivac 指向当前工作文件根目录下的 `multivac/`（工作文件根目录调整后随之更新）；
   * - 没有工作目录的工作会话（含已归档）按创建日期与名称分配临时目录并写入记录；
   * - 未归档会话的目录不存在时创建；已归档会话只记录路径，恢复时再创建。
   */
  prepareOnStartup(): void {
    const multivac = this.multivac();
    for (const record of this.registry.listAll()) {
      const directory = this.assign(record, multivac);
      if (record.archivedAt === null) this.ensure(directory);
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
