import { createHash } from 'node:crypto';
import type {
  AssistantMessageView, CoordinatorModelConfig, CreateNote, DeleteNote, DeletedNote, Note, NoteDiscussion, NoteSnapshot,
  NoteSuggestion, NoteSummary, NoteVersionList, UpdateNoteFields,
} from '@multivac/contracts';

/** 独立笔记应用的领域错误；status 由 HTTP 与工具适配层映射为响应。 */
export class NotesError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * 笔记命令的幂等指纹。编码规则一经持久化即不可改变：
 * 已有回执按原指纹核对，调整会让历史重放变成冲突。
 */
export function notesFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 一次笔记命令的结果；changed 为 false 表示命中已有回执，调用方不再发布变更。 */
export interface NoteCommandResult<T> {
  value: T;
  changed: boolean;
}

/**
 * 笔记正文、版本快照与命令回执的仓储端口。
 * command 是笔记业务的事务入口：回执核对、mutate 内的写入与回执登记一起提交或回滚，
 * mutate 必须同步且简短，不调用模型或等待文件。
 */
export interface NotesRepository {
  list(): NoteSummary[];
  summary(id: string): NoteSummary;
  get(id: string, revision?: number): Note;
  versions(id: string, before?: number, limit?: number): NoteVersionList;
  /** 只读核对已提交的笔记命令，不重新执行。 */
  operation(commandId: string): Note | undefined;
  receipt<T>(commandId: string, fingerprint: string): T | undefined;
  command<T>(commandId: string, fingerprint: string, mutate: () => T): NoteCommandResult<T>;
  /** 仅在 command 的事务内调用；每个正文版本不可变。 */
  writeVersion(note: Note): void;
  create(input: CreateNote): NoteCommandResult<Note>;
  update(id: string, input: UpdateNoteFields): NoteCommandResult<Note>;
  /** check 在删除事务内、写入前执行，用于核对外部占用（例如仍在运行的讨论）。 */
  remove(id: string, input: DeleteNote, check?: () => void): NoteCommandResult<DeletedNote>;
}

/** 笔记讨论与本轮正文快照的仓储端口；写入只在笔记命令事务内调用。 */
export interface NoteAssistantRepository {
  discussion(id: string): NoteDiscussion | null;
  discussions(noteId: string): NoteDiscussion[];
  insertDiscussion(discussion: NoteDiscussion, directory: string, initialModel?: CoordinatorModelConfig): void;
  snapshot(id: string): NoteSnapshot;
  insertSnapshot(snapshot: NoteSnapshot): void;
}

/**
 * 删除笔记时对其讨论会话的处理，由会话层提供：
 * check 在删除事务内拒绝仍在回答的讨论，release 在删除后关闭讨论的运行时。
 */
export interface NoteDiscussionLifecycle {
  check(noteId: string): void;
  release(noteId: string): void;
}

/** 讨论的稳定可读历史与实际模型快照，由会话层提供；不可读时抛错，不以空历史代替。 */
export interface NoteDiscussionSources {
  history(sessionId: string): Promise<readonly AssistantMessageView[]>;
  model(sessionId: string): Promise<CoordinatorModelConfig>;
}

/** 修改建议的仓储端口；写入只在笔记命令事务内调用。 */
export interface NoteSuggestionsRepository {
  get(id: string): NoteSuggestion;
  list(noteId: string, sessionId?: string): NoteSuggestion[];
  /** 同一来源消息已生成的建议批次；不存在时返回 null。 */
  source(key: string): NoteSuggestion[] | null;
  insertSource(key: string, suggestions: NoteSuggestion[]): void;
  put(suggestion: NoteSuggestion): void;
}
