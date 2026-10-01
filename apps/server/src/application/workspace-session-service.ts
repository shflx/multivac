import {
  DEFAULT_PREFERENCES,
  DEFAULT_WORKSPACE_ID,
  RECENT_WORKSPACE_ID,
  DEFAULT_RECENT_DAYS,
  recentSessions,
  DEFAULT_WORKSPACE_SCENE,
  GLOBAL_ASSISTANT_SESSION_ID,
  SESSION_ARCHIVE_ENTRY_LIST_LIMIT,
  SESSION_MOVE_ENTRY_LIST_LIMIT,
  LegacyWorkspaceSceneStateSchema,
  normalizeWorkspaceSessionTitle,
  resolvedScene,
  UNKNOWN_CHANGE_ORIGIN,
  upgradeLegacyWorkspaceScene,
  WorkspaceSceneStateSchema,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type AssistantApiErrorCode,
  type AssistantMessageView,
  type AssistantQuote,
  type CreateWorkspaceSession,
  type MoveSessionToProject,
  type Project,
  type SessionArchivePreview,
  type SessionMovePreview,
  type SessionMoveResult,
  type SessionRestoreResult,
  type SessionTempEntries,
  type TempRetentionDays,
  type WorkbenchChangeOrigin,
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
import { WorkingDirectoryUnavailableError, type SessionWorkingDirectories } from './session-working-directories.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

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
  validateFileQuote?: (quote: import('@multivac/contracts').AssistantFileQuote) => Promise<unknown>;
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
  /** 偏好中的临时目录保留天数（null 为从不清理），用于归档与归入项目前的说明；缺省 30 天。 */
  tempRetentionDays?: () => TempRetentionDays;
  recentDays?: () => number;
  /** 工作台变更事件：会话与现场变化后在这里发布，推给各窗口；未提供时不发布。 */
  events?: WorkbenchEventPublisher;
  now?: () => string;
}

/**
 * 新建会话的输入：与新建接口（`CreateWorkspaceSession`）相同，只是栈式子会话的选中内容可以省略——
 * 界面上从选中内容深入时总带着它；Multivac 在对话中新建子会话时不带，子会话只承接父会话的背景摘录。
 */
export type CreateSessionInput = Omit<CreateWorkspaceSession, 'parent'> & {
  parent?: { sessionId: string; quote?: AssistantQuote };
};

/** 保存现场的选项：基于哪个版本修改（不给出时直接覆盖），以及变更的来源。 */
export interface SaveSceneOptions {
  baseRevision?: number;
  origin?: WorkbenchChangeOrigin;
}

/** 按固定的字段顺序序列化现场，比较内容时不受字段顺序影响。 */
function sceneKey(scene: WorkspaceSceneState): string {
  const widths = Object.fromEntries(Object.entries(scene.widths).sort(([left], [right]) => left.localeCompare(right)));
  return JSON.stringify([
    scene.parallelCount, scene.slots, scene.focusedSessionId, scene.viewMode, widths, scene.barVisible,
  ]);
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
 *
 * 变更成功后在这里发布工作台变更事件（会话快照、带版本的现场），界面操作与 Multivac 内部工具走同一处；
 * 各方法的 origin 注明变更来源（发起窗口、Multivac 的哪一轮），缺省为来源不明。重放与没有实际变化的调用不发布。
 */
export class WorkspaceSessionService {
  private readonly workspaceId: string;
  private readonly now: () => string;
  private readonly tempRetentionDays: () => TempRetentionDays;
  private readonly creating = new Map<string, Promise<{ session: WorkspaceSession; created: boolean }>>();

  constructor(private readonly options: WorkspaceSessionServiceOptions) {
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.tempRetentionDays = options.tempRetentionDays ?? (() => DEFAULT_PREFERENCES.tempRetentionDays);
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
    const stored = this.storedScene(workspaceId);
    return { workspaceId, scene: this.sanitizeScene(workspaceId, stored.scene), revision: stored.revision };
  }

  /**
   * 保存工作区现场。内容（剔除不在工作区中的会话之后）与存储的现场相同时不写入、版本不变；
   * 否则写入、版本加一，并发布 scene.changed。
   *
   * 给出 baseRevision 时是基于该版本的修改：版本已变化（别处改过）且内容不同时拒绝（WORKSPACE_SCENE_CONFLICT），
   * 以服务端现场为准，由窗口读回最新现场后再决定。
   */
  saveScene(workspaceId: string, scene: WorkspaceSceneState, options: SaveSceneOptions = {}): WorkspaceScene {
    const current = this.storedScene(workspaceId);
    const sanitized = this.sanitizeScene(workspaceId, scene);
    // 与存储的原样内容比较：存储里还留着已离开工作区的会话时照常写入，把它真正移出（之后恢复不会回到原栏位）。
    if (sceneKey(sanitized) === sceneKey(current.scene)) return { workspaceId, scene: sanitized, revision: current.revision };
    if (options.baseRevision !== undefined && options.baseRevision !== current.revision) {
      throw new WorkspaceSessionServiceError('WORKSPACE_SCENE_CONFLICT', '工作区现场已在别处更新，请以最新现场为准。');
    }
    if (!this.options.sceneRepository) return { workspaceId, scene: sanitized, revision: current.revision };
    const saved = { workspaceId, scene: sanitized, revision: this.options.sceneRepository.save(workspaceId, sanitized) };
    this.options.events?.publish({ type: 'scene.changed', origin: options.origin ?? UNKNOWN_CHANGE_ORIGIN, scene: saved });
    return saved;
  }

  /**
   * 界面呈现的现场：保存的现场按工作区会话列表的顺序（新建的在前）补位，当前会话不在工作区中时取第一栏，
   * 与工作区视图同一规则（契约 resolvedScene）。“第 N 栏”“当前会话”都以它为准。
   */
  presentedScene(workspaceId: string = this.workspaceId): WorkspaceScene {
    const { scene, revision } = this.getScene(workspaceId);
    return { workspaceId, scene: resolvedScene(scene, this.sceneMembers(workspaceId)), revision };
  }

  /**
   * 按界面同一套栏位规则修改工作区现场并保存（Multivac 的工作区工具）：在界面呈现的现场上做 change，
   * 保存修改后的呈现（与界面保存的内容一致），基于读到的版本；内容没有变化时不写入、不发布。
   * 返回修改前后的现场，调用方据此说明做了什么。
   */
  changeScene(
    workspaceId: string,
    change: (presented: WorkspaceSceneState) => WorkspaceSceneState,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): { before: WorkspaceScene; after: WorkspaceScene } {
    const before = this.presentedScene(workspaceId);
    const next = resolvedScene(change(before.scene), this.sceneMembers(workspaceId));
    // 读取与保存在同一个同步段内完成，期间不会有别的保存插进来；声明版本只是多一重保险。
    const after = this.saveScene(workspaceId, next, { baseRevision: before.revision, origin });
    return { before, after };
  }

  /**
   * 读取一个工作会话（任一工作区，含已归档），只读。全局 Multivac 不是工作会话，按参数错误拒绝；
   * 不存在时 NOT_FOUND。
   */
  get(sessionId: string): WorkspaceSession {
    const record = this.options.repository.get(sessionId);
    if (!record) throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在。');
    if (record.kind !== 'work') {
      throw new WorkspaceSessionServiceError('INVALID_REQUEST', '这是全局 Multivac 自己的会话，不是工作会话。');
    }
    return publicSession(record);
  }

  /** 会话是否有进行中的一轮（含等待授权）；运行时尚未创建或已释放（如已归档）的会话不在运行。 */
  isRunning(sessionId: string): boolean {
    return this.options.runtimes.get(sessionId)?.isRunning?.() ?? false;
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
   * 带 parent 时为栈式子会话：父会话须未归档；带选中内容时它须来自父会话的可读历史；
   * 子会话留在父会话的工作区，记录父会话与来源（父会话的背景摘录与选中内容），父会话本身不被改写。
   */
  create(
    input: CreateSessionInput,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): Promise<{ session: WorkspaceSession; created: boolean }> {
    const title = normalizeWorkspaceSessionTitle(input.title);
    if (!title) {
      return Promise.reject(new WorkspaceSessionServiceError('INVALID_REQUEST', '会话名称不能为空。'));
    }
    if (input.sessionId === GLOBAL_ASSISTANT_SESSION_ID) {
      return Promise.reject(new WorkspaceSessionServiceError('SESSION_ID_CONFLICT', '会话 id 已被全局会话占用。'));
    }
    const pending = this.creating.get(input.sessionId);
    if (pending) return pending;
    const creation = this.createOnce(input.sessionId, title, input.workspaceId, input.parent).then((result) => {
      // 只有真正新建时发布；同 id 的重放返回既有会话，不再发布。
      if (result.created) this.sessionChanged('created', result.session, origin);
      return result;
    }).finally(() => {
      this.creating.delete(input.sessionId);
    });
    this.creating.set(input.sessionId, creation);
    return creation;
  }

  rename(sessionId: string, rawTitle: string, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): WorkspaceSession {
    const title = normalizeWorkspaceSessionTitle(rawTitle);
    if (!title) throw new WorkspaceSessionServiceError('INVALID_REQUEST', '会话名称不能为空。');
    const record = this.requireWorkSession(sessionId);
    if (record.title === title) return publicSession(record);
    const session = publicSession(this.options.repository.rename(record.sessionId, title) ?? record);
    this.sessionChanged('renamed', session, origin);
    return session;
  }

  /**
   * 归档前的核对（不做任何修改）：会话的工作目录；是临时目录时列出其中第一层的条目，
   * 以及当前的保留时长。空的临时目录归档时直接删除，有文件时归档确认卡据此提示一次。
   */
  previewArchive(sessionId: string): SessionArchivePreview {
    const record = this.requireWorkSession(sessionId);
    const workingDirectory = requireWorkingDirectory(record);
    // 临时目录被挂载为项目目录或仍被其他会话使用时不会被删除或清理，按项目目录说明。
    const names = this.options.workingDirectories.followsLifecycle(record) ? listDirectoryEntries(workingDirectory.path) : null;
    return {
      sessionId: record.sessionId,
      workingDirectory,
      files: names && { total: names.length, names: names.slice(0, SESSION_ARCHIVE_ENTRY_LIST_LIMIT) },
      tempRetentionDays: this.tempRetentionDays(),
    };
  }

  /**
   * 归档后会话不再出现在列表中，运行时随之释放；历史与 Pi session 文件保留。
   * 会话同时移出所在工作区保存的现场：之后恢复只补进空栏，不会回到原来的栏位。
   * 这样无论在工作区还是管理 · 会话页归档、工作区此刻是否打开，结果都一样。
   *
   * 临时目录随之进入生命周期：为空时直接删除，有文件时从归档时间起按偏好保留，到期移到废纸篓；
   * Multivac 工作目录与项目目录永不自动清理。
   */
  archive(sessionId: string, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): WorkspaceSession {
    const record = this.requireWorkSession(sessionId);
    if (this.options.runtimes.get(record.sessionId)?.isRunning?.()) {
      throw new WorkspaceSessionServiceError('COMMAND_STATE_MISMATCH', '会话正在运行，请先停止后再归档。');
    }
    const archived = this.options.repository.archive(record.sessionId, this.now()) ?? record;
    this.options.runtimes.release(record.sessionId);
    this.options.workingDirectories.archive(archived);
    const session = publicSession(archived);
    this.sessionChanged('archived', session, origin);
    this.pruneScene(record.workspaceId, origin);
    return session;
  }

  /**
   * 恢复已归档的工作会话：回到原工作区（记录中的工作区不变），沿用原工作目录、父会话与来源，
   * 历史与 Pi session 文件原样保留。归档时释放的运行时不在这里重建，下次访问会话时按绑定恢复。
   *
   * 幂等：未归档的会话直接返回当前记录。父会话已归档时照常恢复子会话，不连带恢复父会话。
   *
   * 清除归档标记之前经 `reopen` 核对工作目录可用并取消临时目录的清理计划；目录已到期移到废纸篓时重建空目录，
   * 结果中写明移走的时间与位置。工作目录不可用（挂载目录被移走或换成文件等）时返回 ASSISTANT_SESSION_UNAVAILABLE，
   * 消息写明原因与路径，会话保持归档。
   */
  restore(sessionId: string, origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN): SessionRestoreResult {
    const record = this.options.repository.get(sessionId);
    if (!record) throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在。');
    if (record.kind !== 'work') {
      throw new WorkspaceSessionServiceError('INVALID_REQUEST', '全局 Multivac 会话不能归档或恢复。');
    }
    this.requireWorkspace(record.workspaceId);
    if (record.archivedAt === null) return { session: publicSession(record), trashedDirectory: null };

    let reopened;
    try {
      reopened = this.options.workingDirectories.reopen(record);
    } catch (error) {
      // 工作目录不可用（挂载目录被移走、换成文件，临时目录建不出来等）：写明原因与路径，会话保持归档。
      const reason = error instanceof WorkingDirectoryUnavailableError ? error.message : '会话工作目录当前不可用';
      throw new WorkspaceSessionServiceError('ASSISTANT_SESSION_UNAVAILABLE', `未能恢复：${reason}。会话保持归档，目录可用后可以重试。`);
    }
    const session = publicSession(this.options.repository.restore(record.sessionId) ?? record);
    this.sessionChanged('restored', session, origin);
    return { session, trashedDirectory: reopened.trashedDirectory };
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
      tempRetentionDays: this.tempRetentionDays(),
      sourceInUse: this.options.workingDirectories.inUse(from, record.sessionId),
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
   * - 原临时目录为空（或已全部移入）时删除，仍有文件时保留，从归入时起按偏好到期移到废纸篓；
   *   它正被项目或其他会话使用时保留原处、不删除也不清理，结果中 sourceInUse 为 true。
   * - 会话移出原工作区保存的现场；项目工作区的现场不变，会话按列表顺序补进空栏。
   * - 已在目标项目中时（重放）原样返回，不做任何修改。
   */
  async moveToProject(
    sessionId: string,
    input: MoveSessionToProject,
    origin: WorkbenchChangeOrigin = UNKNOWN_CHANGE_ORIGIN,
  ): Promise<SessionMoveResult> {
    const record = this.requireWorkSession(sessionId);
    const target = this.requireProjectWorkspace(input.projectId);
    if (record.workspaceId === target.workspaceId) return this.unmoved(record);
    const move = () => this.moveNow(record.sessionId, target, input.moveFiles, origin);
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
    origin: WorkbenchChangeOrigin,
  ): SessionMoveResult {
    // 等待互斥区期间会话可能已被归档或已归入：重新读取记录再判断。
    const record = this.requireWorkSession(sessionId);
    if (record.workspaceId === target.workspaceId) return this.unmoved(record);
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
    const session = publicSession(moved);
    this.sessionChanged('moved', session, origin);
    this.pruneScene(record.workspaceId, origin);
    // 原临时目录仍有文件时，它已不被任何会话引用：从归入时起按偏好计时，到期移到废纸篓。
    // 它正被项目或其他会话使用时（含它就是项目主目录）保留原处，不删除也不登记，结果中写明。
    const sourceRemoved = this.options.workingDirectories.discard(from);
    const sourceInUse = !sourceRemoved && this.options.workingDirectories.inUse(from, null);
    if (!sourceRemoved) this.options.workingDirectories.orphan(from, sessionId);
    return {
      session,
      files: files && {
        moved: files.moved.length,
        skippedTotal: files.skipped.length,
        skipped: files.skipped.slice(0, SESSION_MOVE_ENTRY_LIST_LIMIT),
      },
      sourceRemoved,
      tempRetentionDays: this.tempRetentionDays(),
      sourceInUse,
    };
  }

  /** 存储的现场（旧版两栏现场升级为栏位现场，损坏时回退为默认现场，尚未剔除不在工作区中的会话）与版本。 */
  private storedScene(workspaceId: string): { scene: WorkspaceSceneState; revision: number } {
    if (workspaceId !== RECENT_WORKSPACE_ID) this.requireWorkspace(workspaceId);
    const stored = this.options.sceneRepository?.get(workspaceId);
    const content = stored?.scene;
    const scene = Check(WorkspaceSceneStateSchema, content) ? content
      : Check(LegacyWorkspaceSceneStateSchema, content) ? upgradeLegacyWorkspaceScene(content)
        : DEFAULT_WORKSPACE_SCENE;
    return { scene, revision: stored?.revision ?? 0 };
  }

  /** 工作区中未归档的会话，按会话列表的顺序（新建的在前）：空出的栏按这个顺序补位。 */
  private sceneMembers(workspaceId: string): string[] {
    if (workspaceId === RECENT_WORKSPACE_ID) return recentSessions(this.options.repository.list(null, 'work'), this.options.recentDays?.() ?? DEFAULT_RECENT_DAYS, Date.parse(this.now())).map((record) => record.sessionId);
    return this.options.repository.list(workspaceId, 'work').map((record) => record.sessionId).reverse();
  }

  /** 会话离开工作区（归档、归入项目）后把它移出该工作区保存的现场；现场本来没有它时不写入。 */
  private pruneScene(workspaceId: string, origin: WorkbenchChangeOrigin): void {
    if (this.options.sceneRepository) {
      this.saveScene(workspaceId, this.getScene(workspaceId).scene, { origin });
      this.saveScene(RECENT_WORKSPACE_ID, this.getScene(RECENT_WORKSPACE_ID).scene, { origin });
    }
  }

  private sessionChanged(
    change: 'created' | 'renamed' | 'archived' | 'restored' | 'moved',
    session: WorkspaceSession,
    origin: WorkbenchChangeOrigin,
  ): void {
    this.options.events?.publish({ type: 'session.changed', origin, change, session });
  }

  /** 已在目标项目中（重放）：原样返回，不做任何修改。 */
  private unmoved(record: SessionRecord): SessionMoveResult {
    return { session: publicSession(record), files: null, sourceRemoved: false, tempRetentionDays: this.tempRetentionDays(), sourceInUse: false };
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
    const active = new Set(this.sceneMembers(workspaceId));
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
    parent: CreateSessionInput['parent'],
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
    if (parent?.quote && origin) this.seedOriginQuote(sessionId, parent.sessionId, parent.quote, origin);
    return { session: publicSession(this.options.repository.get(sessionId) ?? record), created: true };
  }

  /**
   * 深入后选中内容作为来自父会话的引用放进子会话输入区：首轮发送带着可见引用，
   * 移除后发送与普通会话一致。只在新建时写入一次，重放不覆盖用户之后的编辑。
   */
  private seedOriginQuote(
    sessionId: string,
    parentSessionId: string,
    quote: AssistantQuote,
    origin: SessionOrigin,
  ): void {
    const repository = this.options.pageStateRepository;
    if (!repository) return;
    const state = repository.get(sessionId);
    repository.save(sessionId, {
      ...state,
      quote: { ...quote, sourceSessionId: parentSessionId, sourceTitle: origin.parentTitle },
    });
  }

  /**
   * 核对父会话与选中内容（有的话），摘录父会话此刻的背景作为子会话的来源。
   * 子会话留在父会话的工作区；请求指定了另一个工作区时拒绝。
   */
  private async resolveOrigin(
    parent: NonNullable<CreateSessionInput['parent']>,
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
    const { quote } = parent;
    if (quote?.sourceSessionId !== undefined && quote.sourceSessionId !== record.sessionId) {
      throw invalid('选中内容不属于父会话。');
    }
    if (!this.options.readSessionHistory) throw invalid('当前不支持栈式深入。');
    let history: Awaited<ReturnType<NonNullable<WorkspaceSessionServiceOptions['readSessionHistory']>>>;
    try {
      history = await this.options.readSessionHistory(record);
    } catch {
      throw invalid('父会话暂时无法读取，请稍后重试。');
    }
    const background = { parentTitle: record.title, parentExcerpt: sessionContextExcerpt(history.messages) };
    if (!quote) return { workspaceId: record.workspaceId, origin: background };
    if (quote.sourceKind === 'file') {
      if (!this.options.validateFileQuote) throw invalid('当前不支持文件选区深入。');
      try { await this.options.validateFileQuote(quote); } catch (reason) { throw invalid(reason instanceof Error ? reason.message : '文件来源无效。'); }
      return { workspaceId: record.workspaceId, origin: { ...background, text: quote.text, sourceFile: quote.sourceFile } };
    }
    const rejection = validateAssistantQuote(quote, history);
    if (rejection) throw invalid(rejection.message);
    return {
      workspaceId: record.workspaceId,
      origin: { ...background, sourcePiEntryId: quote.sourcePiEntryId, sourceRole: quote.sourceRole, text: quote.text },
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
