import type { MoveSessionToProject, SessionMoveResult, WorkspaceSession } from '@multivac/contracts';

/**
 * 工作会话列表（含已归档）在应用内的唯一一份，与界面无关，便于单独测试。
 *
 * 工作区与管理 · 会话页读的是同一份：任一处新建、改名、归档、恢复或归入项目后，都以接口返回的会话写回这里，
 * 另一处立即看到同样的结果，不需要在切换界面时重新读取。其他窗口的变化没有推送，刷新后才可见。
 */

/** 会话生命周期接口；由应用注入真实的 HTTP 客户端，测试注入替身。 */
export interface WorkspaceSessionsApi {
  /** 全部工作会话（含已归档），按创建时间升序。 */
  list(): Promise<readonly WorkspaceSession[]>;
  rename(sessionId: string, title: string): Promise<WorkspaceSession>;
  archive(sessionId: string): Promise<WorkspaceSession>;
  restore(sessionId: string): Promise<WorkspaceSession>;
  moveToProject(sessionId: string, input: MoveSessionToProject): Promise<SessionMoveResult>;
}

/** 以服务端返回的会话替换列表中的同一会话（位置不变），新会话追加在末尾。 */
export function upsertSession(sessions: readonly WorkspaceSession[], session: WorkspaceSession): WorkspaceSession[] {
  return sessions.some((item) => item.sessionId === session.sessionId)
    ? sessions.map((item) => item.sessionId === session.sessionId ? session : item)
    : [...sessions, session];
}

export class WorkspaceSessions {
  // 尚未读取成功时为 null；对外快照保持引用稳定，只在变化时替换（useSyncExternalStore 依赖这一点）。
  private sessions: readonly WorkspaceSession[] | null = null;
  private loading: Promise<void> | null = null;
  // 读取进行中写回的会话：读取结果可能早于这些变化，落地时以它们为准。
  private writtenDuringLoad: Map<string, WorkspaceSession> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: WorkspaceSessionsApi) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): readonly WorkspaceSession[] | null => this.sessions;

  /**
   * 确保列表已读取：已读取时直接完成，读取中时共用同一个请求，读取失败后再次调用会重新读取。
   * 失败时 reject，由调用方各自呈现错误与重试。
   */
  ensureLoaded = (): Promise<void> => {
    if (this.sessions) return Promise.resolve();
    if (this.loading) return this.loading;

    const written = new Map<string, WorkspaceSession>();
    this.writtenDuringLoad = written;
    const loading = this.api.list().then((listed) => {
      let next = [...listed];
      for (const session of written.values()) next = upsertSession(next, session);
      this.sessions = next;
      this.publish();
    }).finally(() => {
      if (this.loading === loading) {
        this.loading = null;
        this.writtenDuringLoad = null;
      }
    });
    this.loading = loading;
    return loading;
  };

  /** 写回接口返回的会话（新建、改名、归档、恢复的结果）。 */
  upsert = (session: WorkspaceSession): void => {
    this.writtenDuringLoad?.set(session.sessionId, session);
    if (!this.sessions) return;
    this.sessions = upsertSession(this.sessions, session);
    this.publish();
  };

  rename = async (sessionId: string, title: string): Promise<WorkspaceSession> =>
    this.written(await this.api.rename(sessionId, title));

  archive = async (sessionId: string): Promise<WorkspaceSession> =>
    this.written(await this.api.archive(sessionId));

  /** 恢复已归档的会话：回到原工作区；重复恢复返回同一结果。 */
  restore = async (sessionId: string): Promise<WorkspaceSession> =>
    this.written(await this.api.restore(sessionId));

  /** 归入项目：会话的工作区与工作目录随之更新，原工作区不再列出它、项目工作区列出它。 */
  moveToProject = async (sessionId: string, input: MoveSessionToProject): Promise<SessionMoveResult> => {
    const result = await this.api.moveToProject(sessionId, input);
    this.upsert(result.session);
    return result;
  };

  private written(session: WorkspaceSession): WorkspaceSession {
    this.upsert(session);
    return session;
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}
