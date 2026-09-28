import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  normalizeProjectName,
  type AssistantApiErrorCode,
  type CreateProject,
  type CreateProjectResponse,
  type Project,
  type ProjectDirectory,
  type ProjectListResponse,
  type WorkspaceListResponse,
} from '@multivac/contracts';
import type { ProjectRepository, WorkspaceRepository } from '../modules/projects/project.js';
import { firstAvailableName, isPathWithin, projectDirectoryName } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';

export class ProjectServiceError extends Error {
  constructor(
    readonly code: AssistantApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectServiceError';
  }
}

export interface ProjectServiceOptions {
  projects: ProjectRepository;
  workspaces: WorkspaceRepository;
  workPaths: MultivacWorkPaths;
  /** 内部数据目录：项目目录不得位于其中。 */
  dataDir: string;
  now?: () => string;
  newId?: () => string;
}

/**
 * 项目与工作区：列出工作区（含项目与目录）、列出与读取项目、新建项目。
 *
 * 新建项目时，挂载目录须是已存在的目录；不挂载时在工作文件根目录的 `projects/` 下创建托管目录，
 * 名称做文件名安全处理，重名时追加序号。项目随之带一个同 id、同名的工作区。
 */
export class ProjectService {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly options: ProjectServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
  }

  listWorkspaces(): WorkspaceListResponse {
    return { workspaces: this.options.workspaces.list() };
  }

  listProjects(): ProjectListResponse {
    return { projects: this.options.projects.list() };
  }

  getProject(projectId: string): Project {
    const project = this.options.projects.get(projectId);
    if (!project) throw new ProjectServiceError('NOT_FOUND', '项目不存在。');
    return project;
  }

  /**
   * 新建项目与同名工作区。目录在写入记录之前就绪（托管目录此时创建），
   * 写入失败时回收刚创建的空托管目录。
   */
  createProject(input: CreateProject): CreateProjectResponse {
    const name = normalizeProjectName(input.name);
    if (!name) throw new ProjectServiceError('INVALID_REQUEST', '项目名称不能为空。');
    const directory = input.directory === undefined
      ? this.createManagedDirectory(name)
      : this.mountedDirectory(input.directory);

    try {
      return this.options.projects.create({
        projectId: this.newId(),
        name,
        directories: [directory],
        defaultConstraints: input.defaultConstraints?.trim() ?? '',
        createdAt: this.now(),
      });
    } catch (error) {
      if (directory.kind === 'managed') removeEmptyDirectory(directory.path);
      throw error;
    }
  }

  /** 删除全部项目与项目工作区，仅供 Fake E2E 在用例之间恢复初始状态；目录本身不删除。 */
  resetForTest(): void {
    this.options.projects.deleteAllForTest();
  }

  /**
   * 挂载目录：须是已存在目录的绝对路径，且不在内部数据目录之下（按字面路径与真实路径各查一次）。
   * 记录规范化后的字面路径；更细的校验（根目录、用户主目录本身等）在这里补充。
   */
  private mountedDirectory(rawPath: string): ProjectDirectory {
    const invalid = (message: string) => new ProjectServiceError('INVALID_REQUEST', message);
    const path = rawPath.trim();
    if (!isAbsolute(path)) throw invalid('挂载目录必须是绝对路径。');
    const resolved = resolve(path);
    let isDirectory = false;
    try {
      isDirectory = statSync(resolved).isDirectory();
    } catch {
      throw invalid(`目录不存在：${resolved}`);
    }
    if (!isDirectory) throw invalid(`不是目录：${resolved}`);
    this.assertOutsideDataDir(resolved);
    return { kind: 'mounted', path: resolved };
  }

  /** 托管目录：`projects/<项目名>/`；磁盘上已存在或已被其他项目记录使用时依次追加 `-2`、`-3`…… */
  private createManagedDirectory(name: string): ProjectDirectory {
    const { projectsDir } = this.options.workPaths;
    const directoryName = firstAvailableName(projectDirectoryName(name), (candidate) => {
      const path = join(projectsDir, candidate);
      return existsSync(path) || this.options.projects.isDirectoryRecorded(path);
    });
    const path = join(projectsDir, directoryName);
    mkdirSync(path, { recursive: true });
    try {
      this.assertOutsideDataDir(path);
    } catch (error) {
      removeEmptyDirectory(path);
      throw error;
    }
    return { kind: 'managed', path };
  }

  private assertOutsideDataDir(path: string): void {
    const dataDir = this.options.dataDir;
    if (isPathWithin(resolve(dataDir), resolve(path)) || isPathWithin(realpathSync.native(dataDir), realpathSync.native(path))) {
      throw new ProjectServiceError('INVALID_REQUEST', '项目目录不能位于 Multivac 的内部数据目录之下。');
    }
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // 目录不存在或非空：保持原样。
  }
}
