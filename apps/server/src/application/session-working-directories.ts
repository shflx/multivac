import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkingDirectory } from '@multivac/contracts';
import type { SessionRecord, SessionRegistryRepository } from '../modules/sessions/session-registry.js';
import { firstAvailableName, sessionTempDirectoryName } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';

/** 由 Multivac 在工作文件根目录中创建与维护的目录类型；项目挂载目录属于用户，不由这里创建。 */
const OWNED_KINDS: ReadonlySet<WorkingDirectory['kind']> = new Set(['session-temp', 'multivac']);

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

  /** 确保 Multivac 维护的工作目录存在；项目挂载目录等用户目录不在这里创建。 */
  ensure(directory: WorkingDirectory): void {
    if (OWNED_KINDS.has(directory.kind)) mkdirSync(directory.path, { recursive: true });
  }

  /** 新建失败时回收刚创建的临时目录；目录非空（已有文件）时保留。 */
  discard(directory: WorkingDirectory): void {
    if (directory.kind !== 'session-temp') return;
    try {
      rmdirSync(directory.path);
    } catch {
      // 目录不存在或非空：保持原样。
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
