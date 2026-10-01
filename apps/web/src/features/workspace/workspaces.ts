import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, type Workspace } from '@multivac/contracts';
import { WORKING_DIRECTORY_KINDS } from './working-directory.js';

/**
 * 工作区列表在应用内的唯一一份（项目工作区带项目与目录，默认工作区在最后），与界面无关，便于单独测试。
 * 工作区只随新建项目增加：读取一次，新建或更新项目后以接口返回的工作区写回；别处的新建与更新经工作台变更事件
 * 同样写回，事件流重连后整体重读一次。
 */
export class Workspaces {
  // 尚未读取成功时为 null；对外快照保持引用稳定，只在变化时替换（useSyncExternalStore 依赖这一点）。
  private workspaces: readonly Workspace[] | null = null;
  private loading: Promise<readonly Workspace[]> | null = null;
  // 尚未读取完成前写回的工作区，以及各个进行中的重读期间写回的工作区：落地时以它们为准。
  private readonly writtenBeforeLoad = new Map<string, Workspace>();
  private readonly writtenDuringReads = new Set<Map<string, Workspace>>();
  private latestRead = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly list: () => Promise<readonly Workspace[]>) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): readonly Workspace[] | null => this.workspaces;

  /** 确保列表已读取并返回它：读取中时共用同一个请求，失败后再次调用会重新读取。 */
  ensureLoaded = (): Promise<readonly Workspace[]> => {
    if (this.workspaces) return Promise.resolve(this.workspaces);
    if (this.loading) return this.loading;
    const loading = this.list().then((listed) => {
      let next: readonly Workspace[] = listed;
      for (const workspace of this.writtenBeforeLoad.values()) next = upsertWorkspace(next, workspace);
      this.writtenBeforeLoad.clear();
      this.workspaces = next;
      this.publish();
      return next;
    }).finally(() => {
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  };

  /**
   * 整体重读一次（工作台事件流连上或重连后）：尚未读取过时什么也不做；首次读取进行中时等它完成后再读。
   * 失败时保留现有列表。
   */
  refresh = async (): Promise<void> => {
    if (!this.workspaces && !this.loading) return;
    await this.loading?.catch(() => undefined);
    if (!this.workspaces) return;
    const read = ++this.latestRead;
    const written = new Map<string, Workspace>();
    this.writtenDuringReads.add(written);
    try {
      let next: readonly Workspace[] = await this.list();
      if (read !== this.latestRead) return;
      for (const workspace of written.values()) next = upsertWorkspace(next, workspace);
      this.workspaces = next;
      this.publish();
    } finally {
      this.writtenDuringReads.delete(written);
    }
  };

  /** 写回工作区（新建或更新项目后的同名工作区，或别处变化推送来的工作区）。 */
  upsert = (workspace: Workspace): void => {
    for (const written of this.writtenDuringReads) written.set(workspace.workspaceId, workspace);
    if (!this.workspaces) {
      this.writtenBeforeLoad.set(workspace.workspaceId, workspace);
      return;
    }
    this.workspaces = upsertWorkspace(this.workspaces, workspace);
    this.publish();
  };

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 已有的工作区原位替换；新的项目工作区排在默认工作区（不属于项目的）之前。 */
function upsertWorkspace(workspaces: readonly Workspace[], workspace: Workspace): Workspace[] {
  if (workspaces.some((item) => item.workspaceId === workspace.workspaceId)) {
    return workspaces.map((item) => item.workspaceId === workspace.workspaceId ? workspace : item);
  }
  return [...workspaces.filter((item) => item.project), workspace, ...workspaces.filter((item) => !item.project)];
}

/** 工作区的显示名称：项目工作区即项目名称；列表尚未读取或找不到时退回默认名称或 id。 */
export function workspaceName(workspaces: readonly Workspace[] | null, workspaceId: string): string {
  const found = workspaces?.find((workspace) => workspace.workspaceId === workspaceId);
  if (found) return found.name;
  return workspaceId === 'recent' ? '最近' : workspaceId === DEFAULT_WORKSPACE_ID ? DEFAULT_WORKSPACE_NAME : workspaceId;
}

/**
 * 工作区一行摘要：项目工作区给出目录类型与主目录（多个目录时注明数量；类型在前，路径过长时省略的是路径末尾），
 * 默认工作区说明不属于项目、会话各用临时目录。
 */
export function workspaceSummary(workspace: Workspace): string {
  const project = workspace.project;
  if (!project) return '不属于项目 · 各会话使用临时目录';
  const [primary] = project.directories;
  if (!primary) return '项目目录缺失';
  const more = project.directories.length > 1 ? ` 等 ${project.directories.length} 个目录` : '';
  const kind = WORKING_DIRECTORY_KINDS[primary.kind === 'managed' ? 'project-managed' : 'project-mounted'].label;
  return `${kind} · ${primary.path}${more}`;
}

/** 本机记住的当前工作区；工作区现场本身保存在服务端，这里只记“上次在哪个工作区”。 */
const CURRENT_WORKSPACE_STORAGE_KEY = 'multivac.workspace.current';

export function rememberedWorkspaceId(): string {
  try {
    return localStorage.getItem(CURRENT_WORKSPACE_STORAGE_KEY) || DEFAULT_WORKSPACE_ID;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
}

export function rememberWorkspaceId(workspaceId: string): void {
  try {
    localStorage.setItem(CURRENT_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // 本机存储不可用时不记住，下次从默认工作区开始。
  }
}
