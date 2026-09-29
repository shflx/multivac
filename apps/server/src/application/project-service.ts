import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import {
  DEFAULT_WORKSPACE_NAME,
  normalizeProjectName,
  UNKNOWN_CHANGE_ORIGIN,
  type AssistantApiErrorCode,
  type CreateProject,
  type CreateProjectResponse,
  type Project,
  type ProjectDirectory,
  type ProjectListResponse,
  type ProjectPreviewResponse,
  type UpdateProject,
  type UpdateProjectResponse,
  type WorkbenchChangeOrigin,
  type WorkspaceListResponse,
} from '@multivac/contracts';
import type { ProjectRepository, WorkspaceRepository } from '../modules/projects/project.js';
import { firstAvailableName, isPathWithin, projectDirectoryName } from '../modules/sessions/working-directory.js';
import type { MultivacWorkPaths } from '../storage/work-paths.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

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
  /** 内部数据目录：项目目录不得位于其中，也不得包含它。 */
  dataDir: string;
  /** 用户主目录：不能整个挂载，`~` 按它展开。缺省为当前用户的主目录，测试中指向临时目录。 */
  homeDir?: string;
  /** 工作台变更事件：项目新建或更新后发布同名工作区，推给各窗口；未提供时不发布。 */
  events?: WorkbenchEventPublisher;
  now?: () => string;
  newId?: () => string;
}

function invalid(message: string): ProjectServiceError {
  return new ProjectServiceError('INVALID_REQUEST', message);
}

/**
 * 项目与工作区：列出工作区（含项目与目录）、列出与读取项目、新建与更新项目。
 *
 * 挂载目录扩大了“目录内的修改自动执行”的范围，只能由用户在界面确认后经这里完成，不作为 Agent 工具提供。
 * 挂载目录（新建时指定或之后挂载）必须通过同一套校验，见 `mountableDirectory`；
 * 不挂载时在工作文件根目录的 `projects/` 下创建托管目录，名称做文件名安全处理，重名时追加序号。
 * 项目名称不区分大小写地唯一，且不能与默认工作区同名：名称同时是工作区在切换菜单里的名字。
 */
export class ProjectService {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly homeDir: string;

  constructor(private readonly options: ProjectServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    this.homeDir = resolve(options.homeDir ?? homedir());
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
   * 按新建的规则核对名称与目录，返回将要使用的目录（托管目录含重名后缀），不创建任何东西。
   * 确认卡用它展示目录与类型；真正创建时仍以 `createProject` 的校验为准。
   */
  previewProject(input: CreateProject): ProjectPreviewResponse {
    const name = this.availableName(input.name, null);
    const directory = input.directory === undefined
      ? { kind: 'managed' as const, path: this.managedDirectoryPath(name) }
      : this.mountableDirectory(input.directory, null);
    return { name, directory };
  }

  /**
   * 新建项目与同名工作区。目录在写入记录之前就绪（托管目录此时创建），
   * 写入失败时回收刚创建的空托管目录。
   */
  createProject(input: CreateProject, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): CreateProjectResponse {
    const { name, directory: planned } = this.previewProject(input);
    const directory = planned.kind === 'managed' ? this.createManagedDirectory(planned.path) : planned;

    let created: CreateProjectResponse;
    try {
      created = this.options.projects.create({
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
    this.options.events?.publish({ type: 'workspace.changed', origin, change: 'created', workspace: created.workspace });
    return created;
  }

  /**
   * 更新项目的名称、目录与默认约束，只改给出的字段。
   *
   * 目录按给出的顺序整体替换（第一个为主目录）：已有的目录保持原类型，不再重新校验（例如目录被移走后仍可卸载或调整顺序）；
   * 新出现的路径按挂载目录校验；未列出的目录被卸载，目录本身不删除。至少保留一个目录。
   * 已有会话的工作目录记在会话上，不随之改变；之后新建的会话使用新的主目录。
   */
  updateProject(
    projectId: string,
    input: UpdateProject,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): UpdateProjectResponse {
    const project = this.getProject(projectId);
    const name = input.name === undefined ? undefined : this.availableName(input.name, projectId);
    const directories = input.directories === undefined ? undefined : this.updatedDirectories(project, input.directories);
    const updated = this.options.projects.update(projectId, {
      ...(name === undefined ? {} : { name }),
      ...(directories === undefined ? {} : { directories }),
      ...(input.defaultConstraints === undefined ? {} : { defaultConstraints: input.defaultConstraints.trim() }),
      updatedAt: this.now(),
    });
    if (!updated) throw new ProjectServiceError('NOT_FOUND', '项目不存在。');
    this.options.events?.publish({ type: 'workspace.changed', origin, change: 'updated', workspace: updated.workspace });
    return updated;
  }

  /** 删除全部项目与项目工作区，仅供 Fake E2E 在用例之间恢复初始状态；目录本身不删除。 */
  resetForTest(): void {
    this.options.projects.deleteAllForTest();
  }

  /** 名称：去掉首尾空白后不能为空；不能叫“默认工作区”；不区分大小写地不与其他项目重名。 */
  private availableName(rawName: string, projectId: string | null): string {
    const name = normalizeProjectName(rawName);
    if (!name) throw invalid('项目名称不能为空。');
    if (name === DEFAULT_WORKSPACE_NAME) throw invalid(`“${DEFAULT_WORKSPACE_NAME}”是保留名称，请换一个项目名称。`);
    const key = name.toLocaleLowerCase();
    const same = this.options.projects.list()
      .find((project) => project.projectId !== projectId && project.name.toLocaleLowerCase() === key);
    if (same) throw invalid(`已有同名项目「${same.name}」，请换一个名称。`);
    return name;
  }

  /** 更新后的目录列表：已有目录原样保留，新路径按挂载目录校验，同一目录不能出现两次。 */
  private updatedDirectories(project: Project, paths: readonly string[]): ProjectDirectory[] {
    if (paths.length === 0) throw invalid('项目至少保留一个目录。');
    const directories: ProjectDirectory[] = [];
    for (const rawPath of paths) {
      const path = this.absolutePath(rawPath);
      const directory = project.directories.find((item) => item.path === path)
        ?? this.mountableDirectory(rawPath, project.projectId);
      if (directories.some((item) => item.path === directory.path)) throw invalid(`同一个目录不能出现两次：${directory.path}`);
      directories.push(directory);
    }
    return directories;
  }

  /**
   * 可以挂载的目录。挂载意味着目录内的修改自动执行，因此只接受范围明确的已有目录：
   * - 绝对路径（`~` 与 `~/` 按用户主目录展开），已存在且是目录；
   * - 不是根目录、用户主目录本身、工作文件根目录本身；
   * - 不在内部数据目录之中，也不包含内部数据目录或工作文件根目录；
   * - 不是本项目或其他项目已有的目录。
   * 每条都按字面路径与真实路径（跟随符号链接）各比一次。记录规范化后的字面路径。
   */
  private mountableDirectory(rawPath: string, projectId: string | null): ProjectDirectory {
    const path = this.absolutePath(rawPath);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw invalid(code === 'ENOENT' || code === 'ENOTDIR' ? `目录不存在：${path}` : `无法访问目录：${path}`);
    }
    if (!isDirectory) throw invalid(`不是目录：${path}`);

    const forms = pathForms(path);
    const { workRoot } = this.options.workPaths;
    const dataDir = resolve(this.options.dataDir);
    const same = (target: string) => overlapsAny(forms, pathForms(target), (left, right) => left === right);
    const inside = (parent: string) => overlapsAny(pathForms(parent), forms, isPathWithin);
    const contains = (child: string) => overlapsAny(forms, pathForms(child), isPathWithin);

    if (forms.some((form) => form === parse(form).root)) throw invalid('不能挂载根目录：它包含整台电脑的文件，请选择具体的项目目录。');
    if (same(this.homeDir)) throw invalid(`不能挂载用户主目录本身（${this.homeDir}），请选择其中具体的项目目录。`);
    if (same(workRoot)) throw invalid(`不能挂载工作文件根目录本身（${workRoot}）：这里存放各会话与 Multivac 的工作目录。`);
    if (inside(dataDir)) throw invalid(`不能挂载 Multivac 的内部数据目录或其中的目录（${dataDir}）。`);
    if (contains(dataDir)) throw invalid(`这个目录包含 Multivac 的内部数据目录（${dataDir}），不能挂载。`);
    if (contains(workRoot)) throw invalid(`这个目录包含工作文件根目录（${workRoot}），不能挂载。`);

    const owner = this.options.projects.list().find((project) => project.directories.some((directory) => same(directory.path)));
    if (owner) {
      throw invalid(owner.projectId === projectId ? `这个目录已经在项目中：${path}` : `这个目录已属于项目「${owner.name}」：${path}`);
    }
    return { kind: 'mounted', path };
  }

  /** 去掉首尾空白，展开 `~`，要求绝对路径，返回规范化后的路径（去掉 `.`、`..` 与末尾的分隔符）。 */
  private absolutePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) throw invalid('目录不能为空。');
    const expanded = trimmed === '~' ? this.homeDir
      : trimmed.startsWith('~/') ? join(this.homeDir, trimmed.slice(2))
        : trimmed;
    if (!isAbsolute(expanded)) throw invalid(`目录必须是绝对路径，例如 /Users/me/code 或 ~/code：${trimmed}`);
    return resolve(expanded);
  }

  /** 托管目录的位置：`projects/<项目名>/`；磁盘上已存在或已被其他项目记录使用时依次追加 `-2`、`-3`…… */
  private managedDirectoryPath(name: string): string {
    const { projectsDir } = this.options.workPaths;
    const directoryName = firstAvailableName(projectDirectoryName(name), (candidate) => {
      const path = join(projectsDir, candidate);
      return existsSync(path) || this.options.projects.isDirectoryRecorded(path);
    });
    return join(projectsDir, directoryName);
  }

  private createManagedDirectory(path: string): ProjectDirectory {
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
      throw invalid('项目目录不能位于 Multivac 的内部数据目录之下。');
    }
  }
}

/** 路径的字面形式与真实路径（跟随符号链接；不存在时只有字面形式）。 */
function pathForms(path: string): string[] {
  const literal = resolve(path);
  try {
    const real = realpathSync.native(literal);
    return real === literal ? [literal] : [literal, real];
  } catch {
    return [literal];
  }
}

/** 两组路径形式中任意一对满足关系即成立。 */
function overlapsAny(
  left: readonly string[],
  right: readonly string[],
  relation: (left: string, right: string) => boolean,
): boolean {
  return left.some((a) => right.some((b) => relation(a, b)));
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // 目录不存在或非空：保持原样。
  }
}
