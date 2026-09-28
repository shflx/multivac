import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SCENE,
  GLOBAL_ASSISTANT_SESSION_ID,
  SESSION_MOVE_ENTRY_LIST_LIMIT,
  LegacyWorkspaceSceneStateSchema,
  normalizeWorkspaceSessionTitle,
  upgradeLegacyWorkspaceScene,
  WorkspaceSceneStateSchema,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type AssistantApiErrorCode,
  type AssistantMessageView,
  type CreateWorkspaceSession,
  type MoveSessionToProject,
  type Project,
  type SessionMovePreview,
  type SessionMoveResult,
  type SessionTempEntries,
  type WorkingDirectory,
  type Workspace,
  type WorkspaceSession,
  type WorkspaceSessionListResponse,
} from '@multivac/contracts';
import { join, resolve } from 'node:path';
import { Check } from 'typebox/value';
import type {
  SessionOrigin,
  SessionRecord,
  SessionRegistryRepository,
  WorkspaceSceneRepository,
} from '../modules/sessions/session-registry.js';
import type { AssistantPageStateRepository } from '../modules/sessions/assistant-session.js';
import type { WorkspaceRepository } from '../modules/projects/project.js';
import { validateAssistantQuote } from '../modules/sessions/assistant-quote.js';
import { sessionContextExcerpt } from '../modules/sessions/session-context.js';
import {
  isPathOccupied,
  listDirectoryEntries,
  moveDirectoryEntries,
} from '../modules/sessions/directory-entries.js';
import { isPathWithin } from '../modules/sessions/working-directory.js';
import type { SessionWorkingDirectories } from './session-working-directories.js';

export class WorkspaceSessionServiceError extends Error {
  constructor(
    readonly code: AssistantApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceSessionServiceError';
  }
}

/** 单个会话在服务端的运行时入口；首次初始化负责建立 Pi session 与绑定。 */
export interface SessionRuntimeHandle {
  initialize(): Promise<unknown>;
  /** 会话是否有进行中的运行（含已受理、重试、压缩与等待授权）。 */
  isRunning?(): boolean;
  /**
   * 在会话的互斥区（发送 handoff 与选模共用）内执行改变执行环境的最后一个操作；
   * 成功后互斥区关闭，排在后面的发送与选模一律拒绝。未提供时 operation 直接执行。
   */
  retire?<T>(operation: () => T): Promise<T>;
}

export interface WorkspaceSessionRuntimes {
  /** 取得（必要时创建）会话运行时；同一会话只有一份。 */
  acquire(record: SessionRecord): SessionRuntimeHandle;
  /** 释放会话运行时（归档或新建失败时），不影响其他会话。 */
  release(sessionId: string): void;
  /** 已创建的运行时；尚未访问过的会话返回 undefined。 */
  get(sessionId: string): SessionRuntimeHandle | undefined;
}

export interface WorkspaceSessionServiceOptions {
  repository: SessionRegistryRepository;
  runtimes: WorkspaceSessionRuntimes;
  /** 新建会话时分配并创建会话的工作目录（项目目录或临时目录）。 */
  workingDirectories: SessionWorkingDirectories;
  /** 工作区（含所属项目与目录）：会话所在工作区须存在，项目工作区的新会话使用项目主目录。 */
  workspaces: WorkspaceRepository;
  /** 工作区现场的存储；未提供时现场只使用默认值。 */
  sceneRepository?: WorkspaceSceneRepository;
  /** 会话页面现场；栈式深入时把选中内容作为引用放进子会话的输入区。 */
  pageStateRepository?: AssistantPageStateRepository;
  /** 读取会话的 Pi session 与可读历史；栈式深入据此核对选中内容并摘录父会话背景。 */
  readSessionHistory?: (record: SessionRecord) => Promise<{
    piSessionId: string;
    messages: readonly AssistantMessageView[];
  }>;
  /** 未指定工作区时（列表、新建）使用的工作区，缺省为默认工作区。 */
  workspaceId?: string;
  now?: () => string;
}

/** 启动迁移已为全部会话补齐工作目录；缺失说明启动流程被绕过，不能对外返回不完整的会话。 */
function requireWorkingDirectory(record: SessionRecord): WorkingDirectory {
  if (!record.workingDirectory) throw new Error(`会话 ${record.sessionId} 缺少工作目录。`);
  return record.workingDirectory;
}

function publicSession(record: SessionRecord): WorkspaceSession {
  const { piSessionPath: _piSessionPath, origin: _origin, workingDirectory: _workingDirectory, ...session } = record;
  return { ...session, workingDirectory: requireWorkingDirectory(record) };
}

/**
 * 工作区会话的生命周期：新建（含独立 Pi session）、列出、改名、归档与恢复、归入项目，以及各工作区的现场。
 * 会话属于且只属于一个工作区，记录在会话上；归档与恢复都不改变它，只有归入项目会改变它（连同工作目录）。
 */
export class WorkspaceSessionService {
  private readonly workspaceId: string;
  private readonly now: () => string;
  private readonly creating = new Map<string, Promise<{ session: WorkspaceSession; created: boolean }>>();

  constructor(private readonly options: WorkspaceSessionServiceOptions) {
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 列出工作区的工作会话，按创建时间升序。workspaceId 缺省为默认工作区，为 null 时跨全部工作区列出。
   * 默认只含未归档会话；includeArchived 时一并返回已归档会话（archivedAt 非空），供“已归档”区与会话管理使用。
   */
  list(options: { includeArchived?: boolean; workspaceId?: string | null } = {}): WorkspaceSessionListResponse {
    const workspaceId = options.workspaceId === undefined ? this.workspaceId : options.workspaceId;
    if (workspaceId !== null) this.requireWorkspace(workspaceId);
    return {
      workspaceId,
      sessions: this.options.repository.list(workspaceId, 'work', { includeArchived: options.includeArchived ?? false })
        .map(publicSession),
    };
  }

  /**
   * 读取工作区现场。已归档或已不存在的会话自动从栏位与当前会话中移除；
   * 旧版两栏现场升级为栏位现场，存储内容损坏时回退为默认现场。
   */
  getScene(workspaceId: string = this.workspaceId): WorkspaceScene {
    this.requireWorkspace(workspaceId);
    const stored = this.options.sceneRepository?.get(workspaceId);
    const scene = Check(WorkspaceSceneStateSchema, stored) ? stored
      : Check(LegacyWorkspaceSceneStateSchema, stored) ? upgradeLegacyWorkspaceScene(stored)
        : DEFAULT_WORKSPACE_SCENE;
    return { workspaceId, scene: this.sanitizeScene(workspaceId, scene) };
  }

  saveScene(workspaceId: string, scene: WorkspaceSceneState): WorkspaceScene {
    this.requireWorkspace(workspaceId);
    const sanitized = this.sanitizeScene(workspaceId, scene);
    this.options.sceneRepository?.save(workspaceId, sanitized);
    return { workspaceId, scene: sanitized };
  }

  /** 取得未归档的会话记录（任一工作区）；全局协调会话始终可用。 */
  resolve(sessionId: string): SessionRecord {
    const record = this.options.repository.get(sessionId);
    if (!record || record.archivedAt !== null) {
      throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在或已归档。');
    }
    return record;
  }

  /**
   * 新建工作会话。sessionId 由客户端生成并作为幂等键：
   * 同 id 同标题（同工作区、同父会话）的重试返回既有会话，否则判为冲突。
   *
   * 会话在指定的工作区中新建（缺省为默认工作区）：工作区属于项目时，工作目录是项目的主目录，
   * 否则是会话自己的临时目录。
   *
   * 带 parent 时为栈式深入：选中内容须来自父会话的可读历史；子会话留在父会话的工作区，
   * 记录父会话与来源，父会话本身不被改写。
   */
  create(input: CreateWorkspaceSession): Promise<{ session: WorkspaceSession; created: boolean }> {
    const title = normalizeWorkspaceSessionTitle(input.title);
    if (!title) {
      return Promise.reject(new WorkspaceSessionServiceError('INVALID_REQUEST', '会话名称不能为空。'));
    }
    if (input.sessionId === GLOBAL_ASSISTANT_SESSION_ID) {
      return Promise.reject(new WorkspaceSessionServiceError('SESSION_ID_CONFLICT', '会话 id 已被全局会话占用。'));
    }
    const pending = this.creating.get(input.sessionId);
    if (pending) return pending;
    const creation = this.createOnce(input.sessionId, title, input.workspaceId, input.parent).finally(() => {
      this.creating.delete(input.sessionId);
    });
    this.creating.set(input.sessionId, creation);
    return creation;
  }

  rename(sessionId: string, rawTitle: string): WorkspaceSession {
    const title = normalizeWorkspaceSessionTitle(rawTitle);
    if (!title) throw new WorkspaceSessionServiceError('INVALID_REQUEST', '会话名称不能为空。');
    const record = this.requireWorkSession(sessionId);
    return publicSession(this.options.repository.rename(record.sessionId, title) ?? record);
  }

  /**
   * 归档后会话不再出现在列表中，运行时随之释放；历史与 Pi session 文件保留。
   * 会话同时移出所在工作区保存的现场：之后恢复只补进空栏，不会回到原来的栏位。
   * 这样无论在工作区还是管理 · 会话页归档、工作区此刻是否打开，结果都一样。
   */
  archive(sessionId: string): WorkspaceSession {
    const record = this.requireWorkSession(sessionId);
    if (this.options.runtimes.get(record.sessionId)?.isRunning?.()) {
      throw new WorkspaceSessionServiceError('COMMAND_STATE_MISMATCH', '会话正在运行，请先停止后再归档。');
    }
    const archived = this.options.repository.archive(record.sessionId, this.now()) ?? record;
    this.options.runtimes.release(record.sessionId);
    if (this.options.sceneRepository) this.saveScene(record.workspaceId, this.getScene(record.workspaceId).scene);
    return publicSession(archived);
  }

  /**
   * 恢复已归档的工作会话：回到原工作区（记录中的工作区不变），沿用原工作目录、父会话与来源，
   * 历史与 Pi session 文件原样保留。归档时释放的运行时不在这里重建，下次访问会话时按绑定恢复。
   *
   * 幂等：未归档的会话直接返回当前记录。父会话已归档时照常恢复子会话，不连带恢复父会话。
   */
  restore(sessionId: string): WorkspaceSession {
    const record = this.options.repository.get(sessionId);
    if (!record) throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在。');
    if (record.kind !== 'work') {
      throw new WorkspaceSessionServiceError('INVALID_REQUEST', '全局 Multivac 会话不能归档或恢复。');
    }
    this.requireWorkspace(record.workspaceId);
    if (record.archivedAt === null) return publicSession(record);

    try {
      this.options.workingDirectories.reopen(record);
    } catch {
      throw new WorkspaceSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', '会话工作目录当前不可用，未能恢复。');
    }
    return publicSession(this.options.repository.restore(record.sessionId) ?? record);
  }

  /**
   * 归入项目前的核对（不做任何修改）：原工作目录与将使用的项目目录、会话此刻是否在运行，
   * 以及原临时目录中的条目与其中和项目目录已有条目同名（不会移入）的条目。
   */
  previewMoveToProject(sessionId: string, projectId: string): SessionMovePreview {
    const record = this.requireWorkSession(sessionId);
    const target = this.requireProjectWorkspace(projectId);
    if (record.workspaceId === target.workspaceId) {
      throw new WorkspaceSessionServiceError('INVALID_REQUEST', '会话已在这个项目中。');
    }
    const from = requireWorkingDirectory(record);
    const to = this.options.workingDirectories.forProject(target.project);
    return {
      sessionId: record.sessionId,
      from,
      to,
      running: this.options.runtimes.get(record.sessionId)?.isRunning?.() ?? false,
      files: this.tempEntries(from, to),
    };
  }

  /**
   * 归入项目（cwdOverride）：会话 id、Pi session 与历史、父会话与来源都不变，
   * 只把记录中的工作区与工作目录（在一个事务中）改为项目工作区与项目主目录，随后释放运行时；
   * 下次访问会话时按记录中的新目录恢复 Pi 会话，工具与目录边界随之以新目录为准。
   *
   * - 只在空闲时进行：在会话的互斥区内复核没有进行中的一轮（含等待授权），与发送 handoff、选模串行，
   *   成功后旧运行时的互斥区关闭，排在后面的发送不会落到旧目录上。
   * - moveFiles 且原工作目录是临时目录时，把其中第一层条目移入项目目录，同名的不覆盖、留在原处。
   * - 原临时目录为空（或已全部移入）时删除，仍有文件时保留。
   * - 会话移出原工作区保存的现场；项目工作区的现场不变，会话按列表顺序补进空栏。
   * - 已在目标项目中时（重放）原样返回，不做任何修改。
   */
  async moveToProject(sessionId: string, input: MoveSessionToProject): Promise<SessionMoveResult> {
    const record = this.requireWorkSession(sessionId);
    const target = this.requireProjectWorkspace(input.projectId);
    if (record.workspaceId === target.workspaceId) return { session: publicSession(record), files: null, sourceRemoved: false };
    const move = () => this.moveNow(record.sessionId, target, input.moveFiles);
    const runtime = this.options.runtimes.get(record.sessionId);
    // 没有运行时时，本进程中这个会话没有进行中的一轮；移动全程同步完成，不会与发送交错。
    return runtime?.retire ? runtime.retire(move) : move();
  }

  /**
   * 仅供 Fake E2E 在用例之间恢复空工作区：删除全部工作区的工作会话记录（含已归档，“已归档”区随之清空）、
   * 释放运行时并清空各工作区的现场。项目与项目工作区由项目服务另行清除。
   */
  resetForTest(): void {
    for (const record of this.options.repository.list(null, 'work', { includeArchived: true })) {
      this.options.runtimes.release(record.sessionId);
      this.options.repository.deleteForTest(record.sessionId);
    }
    for (const workspace of this.options.workspaces.list()) {
      this.options.sceneRepository?.save(workspace.workspaceId, DEFAULT_WORKSPACE_SCENE);
    }
  }

  /** 归入项目的同步部分：在互斥区内（或没有运行时时直接）执行，中间没有 await。 */
  private moveNow(
    sessionId: string,
    target: Workspace & { project: Project },
    moveFiles: boolean,
  ): SessionMoveResult {
    // 等待互斥区期间会话可能已被归档或已归入：重新读取记录再判断。
    const record = this.requireWorkSession(sessionId);
    if (record.workspaceId === target.workspaceId) return { session: publicSession(record), files: null, sourceRemoved: false };
    if (this.options.runtimes.get(sessionId)?.isRunning?.()) {
      throw new WorkspaceSessionServiceError('COMMAND_STATE_MISMATCH', '会话正在运行（或在等待授权），请先停止后再归入项目。');
    }
    const from = requireWorkingDirectory(record);
    const to = this.options.workingDirectories.forProject(target.project);
    try {
      this.options.workingDirectories.prepare(to);
    } catch {
      throw new WorkspaceSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', `项目目录当前不可用，未能归入：${to.path}`);
    }

    // 先移文件再改记录：中途失败时会话仍在原处，可以重试，已移入的文件不会丢。
    const files = moveFiles && this.tempEntries(from, to) ? moveDirectoryEntries(from.path, to.path) : null;
    const moved = this.options.repository.moveToWorkspace(sessionId, {
      fromWorkspaceId: record.workspaceId,
      toWorkspaceId: target.workspaceId,
      workingDirectory: to,
    });
    if (!moved) throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在或已归档。');
    // 旧运行时仍以原目录为 cwd：释放后下次访问按记录中的新目录重建。
    this.options.runtimes.release(sessionId);
    if (this.options.sceneRepository) this.saveScene(record.workspaceId, this.getScene(record.workspaceId).scene);
    return {
      session: publicSession(moved),
      files: files && {
        moved: files.moved.length,
        skippedTotal: files.skipped.length,
        skipped: files.skipped.slice(0, SESSION_MOVE_ENTRY_LIST_LIMIT),
      },
      sourceRemoved: this.options.workingDirectories.discard(from),
    };
  }

  /**
   * 原工作目录是临时目录时其中的条目与同名冲突；不是临时目录时为 null。
   * 两个目录相互包含时（移入会把目录移进自己）同样不提供移入。
   */
  private tempEntries(from: WorkingDirectory, to: WorkingDirectory): SessionTempEntries | null {
    if (from.kind !== 'session-temp') return null;
    const [source, target] = [resolve(from.path), resolve(to.path)];
    if (isPathWithin(source, target) || isPathWithin(target, source)) return null;
    const names = listDirectoryEntries(source);
    const conflicts = names.filter((name) => isPathOccupied(join(target, name)));
    return {
      total: names.length,
      names: names.slice(0, SESSION_MOVE_ENTRY_LIST_LIMIT),
      conflictTotal: conflicts.length,
      conflicts: conflicts.slice(0, SESSION_MOVE_ENTRY_LIST_LIMIT),
    };
  }

  /** 归入的目标：必须是项目的同名工作区。 */
  private requireProjectWorkspace(projectId: string): Workspace & { project: Project } {
    const workspace = this.options.workspaces.get(projectId);
    if (!workspace) throw new WorkspaceSessionServiceError('NOT_FOUND', '项目不存在。');
    if (!workspace.project) throw new WorkspaceSessionServiceError('INVALID_REQUEST', '只能归入项目。');
    return workspace as Workspace & { project: Project };
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.options.workspaces.get(workspaceId);
    if (!workspace) throw new WorkspaceSessionServiceError('NOT_FOUND', '工作区不存在。');
    return workspace;
  }

  /**
   * 栏位只保留工作区中仍在的会话并去重，不超过并排数；列宽只保留栏数与并排数一致的记录；
   * 当前会话不在工作区中时清空。
   */
  private sanitizeScene(workspaceId: string, scene: WorkspaceSceneState): WorkspaceSceneState {
    const active = new Set(this.options.repository.list(workspaceId, 'work').map((record) => record.sessionId));
    const slots = [...new Set(scene.slots)].filter((sessionId) => active.has(sessionId)).slice(0, scene.parallelCount);
    const widths = Object.fromEntries(Object.entries(scene.widths).filter(([count, values]) => values.length === Number(count)));
    const focusedSessionId = scene.focusedSessionId && active.has(scene.focusedSessionId)
      ? scene.focusedSessionId
      : null;
    return { ...scene, slots, widths, focusedSessionId };
  }

  private async createOnce(
    sessionId: string,
    title: string,
    requestedWorkspaceId: string | undefined,
    parent: CreateWorkspaceSession['parent'],
  ): Promise<{ session: WorkspaceSession; created: boolean }> {
    const existing = this.options.repository.get(sessionId);
    if (existing) {
      return { session: this.replayCreate(existing, title, requestedWorkspaceId, parent?.sessionId), created: false };
    }

    const { origin, workspaceId } = parent
      ? await this.resolveOrigin(parent, requestedWorkspaceId)
      : { origin: undefined, workspaceId: requestedWorkspaceId ?? this.workspaceId };
    const workspace = this.requireWorkspace(workspaceId);
    // 分配、写入记录与创建目录之间没有 await：进程内的并发新建不会分到同一个临时目录。
    const createdAt = this.now();
    const workingDirectory = this.options.workingDirectories.allocateForNewSession(
      workspace.project, { sessionId, title, createdAt },
    );
    const { record, inserted } = this.options.repository.insertIfAbsent({
      sessionId,
      title,
      kind: 'work',
      workspaceId,
      createdAt,
      workingDirectory,
      ...(parent && origin ? { parentSessionId: parent.sessionId, origin } : {}),
    });
    // 重放以既有记录为准，不再创建目录。
    if (!inserted) {
      return { session: this.replayCreate(record, title, requestedWorkspaceId, parent?.sessionId), created: false };
    }

    try {
      this.options.workingDirectories.ensure(workingDirectory);
      await this.options.runtimes.acquire(record).initialize();
    } catch (error) {
      // 目录或 Pi session 未能建立：回收半成品记录与空的临时目录（项目目录不回收），客户端可用同一 id 重试。
      this.options.runtimes.release(sessionId);
      if (this.options.repository.deleteIfUnbound(sessionId)) this.options.workingDirectories.discard(workingDirectory);
      throw error;
    }
    if (parent && origin) this.seedOriginQuote(sessionId, parent, origin);
    return { session: publicSession(this.options.repository.get(sessionId) ?? record), created: true };
  }

  /**
   * 深入后选中内容作为来自父会话的引用放进子会话输入区：首轮发送带着可见引用，
   * 移除后发送与普通会话一致。只在新建时写入一次，重放不覆盖用户之后的编辑。
   */
  private seedOriginQuote(
    sessionId: string,
    parent: NonNullable<CreateWorkspaceSession['parent']>,
    origin: SessionOrigin,
  ): void {
    const repository = this.options.pageStateRepository;
    if (!repository) return;
    const state = repository.get(sessionId);
    repository.save(sessionId, {
      ...state,
      quote: { ...parent.quote, sourceSessionId: parent.sessionId, sourceTitle: origin.parentTitle },
    });
  }

  /**
   * 核对父会话与选中内容，摘录父会话此刻的背景作为子会话的来源。
   * 子会话留在父会话的工作区；请求指定了另一个工作区时拒绝。
   */
  private async resolveOrigin(
    parent: NonNullable<CreateWorkspaceSession['parent']>,
    requestedWorkspaceId: string | undefined,
  ): Promise<{ origin: SessionOrigin; workspaceId: string }> {
    const invalid = (message: string) => new WorkspaceSessionServiceError('INVALID_REQUEST', message);
    let record: SessionRecord;
    try {
      record = this.resolve(parent.sessionId);
    } catch {
      throw invalid('父会话不存在或已归档。');
    }
    if (record.kind !== 'work') throw invalid('只能从工作会话深入。');
    if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== record.workspaceId) {
      throw invalid('栈式子会话只能留在父会话所在的工作区。');
    }
    if (parent.quote.sourceSessionId !== undefined && parent.quote.sourceSessionId !== record.sessionId) {
      throw invalid('选中内容不属于父会话。');
    }
    if (!this.options.readSessionHistory) throw invalid('当前不支持栈式深入。');
    let history: Awaited<ReturnType<NonNullable<WorkspaceSessionServiceOptions['readSessionHistory']>>>;
    try {
      history = await this.options.readSessionHistory(record);
    } catch {
      throw invalid('父会话暂时无法读取，请稍后重试。');
    }
    const rejection = validateAssistantQuote(parent.quote, history);
    if (rejection) throw invalid(rejection.message);
    return {
      workspaceId: record.workspaceId,
      origin: {
        sourcePiEntryId: parent.quote.sourcePiEntryId,
        sourceRole: parent.quote.sourceRole,
        text: parent.quote.text,
        parentTitle: record.title,
        parentExcerpt: sessionContextExcerpt(history.messages),
      },
    };
  }

  /** 重放须与既有会话一致：同标题、同父会话；指定了工作区时须是同一工作区。 */
  private replayCreate(
    record: SessionRecord,
    title: string,
    workspaceId: string | undefined,
    parentSessionId?: string,
  ): WorkspaceSession {
    const expectedWorkspaceId = workspaceId ?? (parentSessionId === undefined ? this.workspaceId : record.workspaceId);
    if (record.kind !== 'work' || record.workspaceId !== expectedWorkspaceId || record.title !== title ||
        record.archivedAt !== null || record.parentSessionId !== (parentSessionId ?? null)) {
      throw new WorkspaceSessionServiceError('SESSION_ID_CONFLICT', '会话 id 已被其他会话使用。');
    }
    return publicSession(record);
  }

  private requireWorkSession(sessionId: string): SessionRecord {
    const record = this.resolve(sessionId);
    if (record.kind !== 'work') {
      throw new WorkspaceSessionServiceError('INVALID_REQUEST', '全局 Multivac 会话不能改名或归档。');
    }
    return record;
  }
}
