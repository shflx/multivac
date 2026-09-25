import {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_SCENE,
  GLOBAL_ASSISTANT_SESSION_ID,
  normalizeWorkspaceSessionTitle,
  WorkspaceSceneStateSchema,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type AssistantApiErrorCode,
  type AssistantMessageView,
  type CreateWorkspaceSession,
  type WorkspaceSession,
  type WorkspaceSessionListResponse,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import type {
  SessionOrigin,
  SessionRecord,
  SessionRegistryRepository,
  WorkspaceSceneRepository,
} from '../modules/sessions/session-registry.js';
import { validateAssistantQuote } from '../modules/sessions/assistant-quote.js';
import { sessionContextExcerpt } from '../modules/sessions/session-context.js';

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
  /** 会话是否有进行中的运行（含已受理、重试与压缩）。 */
  isRunning?(): boolean;
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
  /** 工作区现场的存储；未提供时现场只使用默认值。 */
  sceneRepository?: WorkspaceSceneRepository;
  /** 读取会话的 Pi session 与可读历史；栈式深入据此核对选中内容并摘录父会话背景。 */
  readSessionHistory?: (record: SessionRecord) => Promise<{
    piSessionId: string;
    messages: readonly AssistantMessageView[];
  }>;
  workspaceId?: string;
  now?: () => string;
}

function publicSession(record: SessionRecord): WorkspaceSession {
  const { piSessionPath: _piSessionPath, origin: _origin, ...session } = record;
  return session;
}

/** 工作区会话的生命周期：新建（含独立 Pi session）、列出、改名与归档。 */
export class WorkspaceSessionService {
  private readonly workspaceId: string;
  private readonly now: () => string;
  private readonly creating = new Map<string, Promise<{ session: WorkspaceSession; created: boolean }>>();

  constructor(private readonly options: WorkspaceSessionServiceOptions) {
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  list(): WorkspaceSessionListResponse {
    return {
      workspaceId: this.workspaceId,
      sessions: this.options.repository.list(this.workspaceId, 'work').map(publicSession),
    };
  }

  /**
   * 读取工作区现场。已归档或已不存在的会话自动从顺序与当前会话中移除；
   * 存储内容损坏时回退为默认现场。
   */
  getScene(workspaceId: string = this.workspaceId): WorkspaceScene {
    this.requireWorkspace(workspaceId);
    const stored = this.options.sceneRepository?.get(workspaceId);
    const scene = Check(WorkspaceSceneStateSchema, stored) ? stored : DEFAULT_WORKSPACE_SCENE;
    return { workspaceId, scene: this.sanitizeScene(scene) };
  }

  saveScene(workspaceId: string, scene: WorkspaceSceneState): WorkspaceScene {
    this.requireWorkspace(workspaceId);
    const sanitized = this.sanitizeScene(scene);
    this.options.sceneRepository?.save(workspaceId, sanitized);
    return { workspaceId, scene: sanitized };
  }

  /** 取得未归档的会话记录；全局协调会话始终可用。 */
  resolve(sessionId: string): SessionRecord {
    const record = this.options.repository.get(sessionId);
    if (!record || record.archivedAt !== null || record.workspaceId !== this.workspaceId) {
      throw new WorkspaceSessionServiceError('NOT_FOUND', '会话不存在或已归档。');
    }
    return record;
  }

  /**
   * 新建工作会话。sessionId 由客户端生成并作为幂等键：
   * 同 id 同标题（同父会话）的重试返回既有会话，否则判为冲突。
   *
   * 带 parent 时为栈式深入：选中内容须来自父会话的可读历史；子会话记录父会话与来源，
   * 父会话本身不被改写。
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
    const creation = this.createOnce(input.sessionId, title, input.parent).finally(() => {
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

  /** 归档后会话不再出现在列表中，运行时随之释放；历史与 Pi session 文件保留。 */
  archive(sessionId: string): WorkspaceSession {
    const record = this.requireWorkSession(sessionId);
    if (this.options.runtimes.get(record.sessionId)?.isRunning?.()) {
      throw new WorkspaceSessionServiceError('COMMAND_STATE_MISMATCH', '会话正在运行，请先停止后再归档。');
    }
    const archived = this.options.repository.archive(record.sessionId, this.now()) ?? record;
    this.options.runtimes.release(record.sessionId);
    return publicSession(archived);
  }

  /** 仅供 Fake E2E 在用例之间恢复空工作区：归档全部工作会话、释放运行时并清空现场。 */
  resetForTest(): void {
    for (const record of this.options.repository.list(this.workspaceId, 'work')) {
      this.options.repository.archive(record.sessionId, this.now());
      this.options.runtimes.release(record.sessionId);
    }
    this.options.sceneRepository?.save(this.workspaceId, DEFAULT_WORKSPACE_SCENE);
  }

  private requireWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new WorkspaceSessionServiceError('NOT_FOUND', '工作区不存在。');
    }
  }

  /** 顺序只保留工作区中仍在的会话并去重；当前会话不在其中时清空。 */
  private sanitizeScene(scene: WorkspaceSceneState): WorkspaceSceneState {
    const active = new Set(this.options.repository.list(this.workspaceId, 'work').map((record) => record.sessionId));
    const order = [...new Set(scene.order)].filter((sessionId) => active.has(sessionId));
    const focusedSessionId = scene.focusedSessionId && active.has(scene.focusedSessionId)
      ? scene.focusedSessionId
      : null;
    return { ...scene, order, focusedSessionId };
  }

  private async createOnce(
    sessionId: string,
    title: string,
    parent: CreateWorkspaceSession['parent'],
  ): Promise<{ session: WorkspaceSession; created: boolean }> {
    const existing = this.options.repository.get(sessionId);
    if (existing) return { session: this.replayCreate(existing, title, parent?.sessionId), created: false };

    const origin = parent ? await this.resolveOrigin(parent) : undefined;
    const { record, inserted } = this.options.repository.insertIfAbsent({
      sessionId,
      title,
      kind: 'work',
      workspaceId: this.workspaceId,
      createdAt: this.now(),
      ...(parent && origin ? { parentSessionId: parent.sessionId, origin } : {}),
    });
    if (!inserted) return { session: this.replayCreate(record, title, parent?.sessionId), created: false };

    try {
      await this.options.runtimes.acquire(record).initialize();
    } catch (error) {
      // Pi session 未能建立：回收半成品记录，客户端可用同一 id 重试。
      this.options.runtimes.release(sessionId);
      this.options.repository.deleteIfUnbound(sessionId);
      throw error;
    }
    return { session: publicSession(this.options.repository.get(sessionId) ?? record), created: true };
  }

  /** 核对父会话与选中内容，摘录父会话此刻的背景作为子会话的来源。 */
  private async resolveOrigin(parent: NonNullable<CreateWorkspaceSession['parent']>): Promise<SessionOrigin> {
    const invalid = (message: string) => new WorkspaceSessionServiceError('INVALID_REQUEST', message);
    let record: SessionRecord;
    try {
      record = this.resolve(parent.sessionId);
    } catch {
      throw invalid('父会话不存在或已归档。');
    }
    if (record.kind !== 'work') throw invalid('只能从工作会话深入。');
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
      sourcePiEntryId: parent.quote.sourcePiEntryId,
      sourceRole: parent.quote.sourceRole,
      text: parent.quote.text,
      parentTitle: record.title,
      parentExcerpt: sessionContextExcerpt(history.messages),
    };
  }

  private replayCreate(record: SessionRecord, title: string, parentSessionId?: string): WorkspaceSession {
    if (record.kind !== 'work' || record.workspaceId !== this.workspaceId || record.title !== title ||
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
