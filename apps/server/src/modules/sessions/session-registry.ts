import type { WorkspaceSession, WorkspaceSessionKind } from '@multivac/contracts';

/**
 * 会话注册表中的一条记录。
 *
 * Pi session 文件由 `assistant_session_binding` 记录；注册表只保存会话的产品身份
 * （标题、类型、所属工作区与生命周期），读取时联表带出文件路径。
 */
export interface SessionRecord extends WorkspaceSession {
  piSessionPath: string | null;
}

export interface NewSessionRecord {
  sessionId: string;
  title: string;
  kind: WorkspaceSessionKind;
  workspaceId: string;
  createdAt: string;
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
