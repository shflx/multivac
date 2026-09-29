import type {
  WorkingDirectory,
  WorkspaceSceneState,
  WorkspaceSession,
  WorkspaceSessionKind,
} from '@multivac/contracts';

/**
 * 会话注册表中的一条记录。
 *
 * Pi session 文件由 `assistant_session_binding` 记录；注册表只保存会话的产品身份
 * （标题、类型、所属工作区、工作目录与生命周期），读取时联表带出文件路径。
 */
export interface SessionRecord extends Omit<WorkspaceSession, 'workingDirectory'> {
  /**
   * 会话的工作目录，是工作目录的唯一权威来源（不读取 Pi 会话头中的 cwd）。
   * 只有尚未完成启动迁移的存量记录为 null；服务启动时补齐后才对外提供会话。
   */
  workingDirectory: WorkingDirectory | null;
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
  workingDirectory: WorkingDirectory;
}

export interface SessionRegistryRepository {
  get(sessionId: string): SessionRecord | undefined;
  /** 列出工作区（null 为全部工作区）中指定类型的会话，按创建时间升序；默认不含已归档会话。 */
  list(workspaceId: string | null, kind: WorkspaceSessionKind, options?: { includeArchived?: boolean }): SessionRecord[];
  /** 同 id 已存在时不覆盖，返回既有记录与是否本次写入。 */
  insertIfAbsent(record: NewSessionRecord): { record: SessionRecord; inserted: boolean };
  rename(sessionId: string, title: string): SessionRecord | undefined;
  /** 重复归档保留第一次的归档时间。 */
  archive(sessionId: string, archivedAt: string): SessionRecord | undefined;
  /** 清除归档时间，其余字段（工作区、工作目录、父会话与来源）原样保留；未归档的会话不变。 */
  restore(sessionId: string): SessionRecord | undefined;
  /** 仅删除尚未建立 Pi 绑定的记录；用于新建失败时回收半成品。 */
  deleteIfUnbound(sessionId: string): boolean;
  /** 删除会话记录，仅供 Fake E2E 在用例之间恢复空工作区（含已归档区）；正常流程只归档，不删除。 */
  deleteForTest(sessionId: string): void;
  /** 全部会话记录（跨工作区、含已归档），供启动时的工作目录迁移使用。 */
  listAll(): SessionRecord[];
  setWorkingDirectory(sessionId: string, workingDirectory: WorkingDirectory): SessionRecord | undefined;
  /**
   * 归入项目：在一个事务中改会话所在的工作区与工作目录，其余字段（id、标题、父会话与来源、Pi 绑定）不变。
   * 只改仍在 fromWorkspaceId、未归档的工作会话；条件不满足时不做修改并返回 undefined。
   */
  moveToWorkspace(sessionId: string, move: SessionWorkspaceMove): SessionRecord | undefined;
  /** 是否已有会话记录使用该路径作为工作目录（不区分 ASCII 大小写，兼顾大小写不敏感的文件系统）。 */
  isWorkingDirectoryRecorded(path: string): boolean;
}

export interface SessionWorkspaceMove {
  fromWorkspaceId: string;
  toWorkspaceId: string;
  workingDirectory: WorkingDirectory;
}

/** 存储的工作区现场：内容原样返回（由应用层按契约校验），版本随每次保存加一。 */
export interface StoredWorkspaceScene {
  scene: unknown;
  revision: number;
}

/** 工作区现场的持久化。 */
export interface WorkspaceSceneRepository {
  /** 从未保存过时返回 undefined。 */
  get(workspaceId: string): StoredWorkspaceScene | undefined;
  /** 保存并返回新版本（原版本加一）。 */
  save(workspaceId: string, scene: WorkspaceSceneState): number;
}
