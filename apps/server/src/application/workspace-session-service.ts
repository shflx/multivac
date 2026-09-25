import {
  DEFAULT_WORKSPACE_ID,
  GLOBAL_ASSISTANT_SESSION_ID,
  normalizeWorkspaceSessionTitle,
  type AssistantApiErrorCode,
  type CreateWorkspaceSession,
  type WorkspaceSession,
  type WorkspaceSessionListResponse,
} from '@multivac/contracts';
import type { SessionRecord, SessionRegistryRepository } from '../modules/sessions/session-registry.js';

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
  workspaceId?: string;
  now?: () => string;
}

function publicSession(record: SessionRecord): WorkspaceSession {
  const { piSessionPath: _piSessionPath, ...session } = record;
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
   * 同 id 同标题的重试返回既有会话，同 id 不同标题判为冲突。
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
    const creation = this.createOnce(input.sessionId, title).finally(() => {
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

  private async createOnce(
    sessionId: string,
    title: string,
  ): Promise<{ session: WorkspaceSession; created: boolean }> {
    const existing = this.options.repository.get(sessionId);
    if (existing) return { session: this.replayCreate(existing, title), created: false };

    const { record, inserted } = this.options.repository.insertIfAbsent({
      sessionId,
      title,
      kind: 'work',
      workspaceId: this.workspaceId,
      createdAt: this.now(),
    });
    if (!inserted) return { session: this.replayCreate(record, title), created: false };

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

  private replayCreate(record: SessionRecord, title: string): WorkspaceSession {
    if (record.kind !== 'work' || record.workspaceId !== this.workspaceId || record.title !== title ||
        record.archivedAt !== null) {
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
