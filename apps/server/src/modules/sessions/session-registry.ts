import type { WorkspaceSceneState, WorkspaceSession, WorkspaceSessionKind } from '@multivac/contracts';

/**
 * 会话注册表中的一条记录。
 *
 * Pi session 文件由 `assistant_session_binding` 记录；注册表只保存会话的产品身份
 * （标题、类型、所属工作区与生命周期），读取时联表带出文件路径。
 */
export interface SessionRecord extends WorkspaceSession {
  piSessionPath: string | null;
  /** 栈式深入的来源：父会话中选中的内容与深入时父会话的背景摘录。 */
  origin: SessionOrigin | null;
}

/** 深入时从父会话带到子会话的来源；在子会话首轮作为用户数据交给模型。 */
export interface SessionOrigin {
  sourcePiEntryId: string;
  sourceRole: 'user' | 'assistant';
  text: string;
  parentTitle: string;
  parentExcerpt: string;
}

export interface NewSessionRecord {
  sessionId: string;
  title: string;
  kind: WorkspaceSessionKind;
  workspaceId: string;
  createdAt: string;
  parentSessionId?: string;
  origin?: SessionOrigin;
}

export interface SessionRegistryRepository {
  get(sessionId: string): SessionRecord | undefined;
  /** 列出工作区中指定类型的会话，按创建时间升序；默认不含已归档会话。 */
  list(workspaceId: string, kind: WorkspaceSessionKind, options?: { includeArchived?: boolean }): SessionRecord[];
  /** 同 id 已存在时不覆盖，返回既有记录与是否本次写入。 */
  insertIfAbsent(record: NewSessionRecord): { record: SessionRecord; inserted: boolean };
  rename(sessionId: string, title: string): SessionRecord | undefined;
  archive(sessionId: string, archivedAt: string): SessionRecord | undefined;
  /** 仅删除尚未建立 Pi 绑定的记录；用于新建失败时回收半成品。 */
  deleteIfUnbound(sessionId: string): boolean;
}

/** 工作区现场的持久化：读取原样返回存储内容，由应用层按契约校验。 */
export interface WorkspaceSceneRepository {
  get(workspaceId: string): unknown;
  save(workspaceId: string, scene: WorkspaceSceneState): void;
}
