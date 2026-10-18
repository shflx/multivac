import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from './sqlite-transaction.js';
import type { NewSessionRecord, SessionOrigin, SessionRecord, SessionRegistryRepository, SessionWorkspaceMove } from '../modules/sessions/session-registry.js';
import type { CoordinatorModelConfig, WorkingDirectory, WorkspaceSessionKind } from '@multivac/contracts';
import { COORDINATOR_THINKING_LEVELS, FileQuoteSourceSchema, WorkingDirectorySchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { Type } from 'typebox';

interface SessionRow {
  host_note_id?: string | null;
  host_note_title?: string | null;
  host_book_id?: string | null;
  host_book_title?: string | null;
  session_id: string;
  title: string;
  kind: WorkspaceSessionKind;
  workspace_id: string;
  created_at: string;
  archived_at: string | null;
  parent_session_id: string | null;
  origin_json: string | null;
  initial_model_json: string | null;
  working_directory_kind: string | null;
  working_directory_path: string | null;
  pi_session_path: string | null;
  last_activity_at?: string;
}

const SESSION_SELECT = `
  SELECT r.session_id, r.title, r.kind, r.workspace_id, r.created_at, r.archived_at,
         r.parent_session_id, r.origin_json, r.initial_model_json, r.working_directory_kind, r.working_directory_path,
         b.pi_session_path AS pi_session_path,
         nd.note_id AS host_note_id, json_extract(n.record_json, '$.title') AS host_note_title,
         d.book_id AS host_book_id, json_extract(book.record_json, '$.title') AS host_book_title,
         COALESCE((SELECT MAX(e.occurred_at) FROM assistant_event_projection e
           WHERE e.assistant_id = r.session_id AND e.event_type IN
             ('assistant.command.handed_to_pi', 'assistant.message.delta', 'assistant.turn.started', 'assistant.turn.ended', 'assistant.tool.ended')), r.created_at) AS last_activity_at
  FROM assistant_session_registry r
  LEFT JOIN assistant_session_binding b ON b.assistant_id = r.session_id
  LEFT JOIN reading_discussion d ON d.session_id = r.session_id
  LEFT JOIN reading_book book ON book.book_id = d.book_id
  LEFT JOIN app_note_discussion nd ON nd.session_id = r.session_id
  LEFT JOIN app_note n ON n.id = nd.note_id
`;

/**
 * 来源引用损坏时视为没有来源，不阻断会话读取。选中内容的三个字段要么齐全，要么都没有
 * （Multivac 在对话中新建的子会话只带父会话的背景摘录）。
 */
function originFromColumn(value: string | null): SessionOrigin | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.parentTitle !== 'string' || typeof parsed.parentExcerpt !== 'string') return null;
    const background = { parentTitle: parsed.parentTitle, parentExcerpt: parsed.parentExcerpt };
    if (Check(FileQuoteSourceSchema, parsed.sourceFile) && typeof parsed.text === 'string' && parsed.text) return { ...background, text: parsed.text, sourceFile: parsed.sourceFile };
    if (parsed.text === undefined && parsed.sourcePiEntryId === undefined && parsed.sourceRole === undefined) {
      return background;
    }
    if (typeof parsed.text !== 'string' || !parsed.text ||
        typeof parsed.sourcePiEntryId !== 'string' ||
        (parsed.sourceRole !== 'user' && parsed.sourceRole !== 'assistant')) return null;
    return { ...background, sourcePiEntryId: parsed.sourcePiEntryId, sourceRole: parsed.sourceRole, text: parsed.text };
  } catch {
    return null;
  }
}

/** 工作目录列缺失（尚未迁移）或类型无法识别时视为没有工作目录，由启动迁移补齐。 */
function workingDirectoryFromColumns(kind: string | null, path: string | null): WorkingDirectory | null {
  const value = { kind, path };
  return Check(WorkingDirectorySchema, value) ? value : null;
}

const InitialModelSchema = Type.Object({
  provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Enum(COORDINATOR_THINKING_LEVELS),
  source: Type.Optional(Type.Union([Type.Literal('base'), Type.Literal('controlled')])),
  profileId: Type.Optional(Type.String({ minLength: 1 })), protocol: Type.Optional(Type.String({ minLength: 1 })),
  endpoint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  endpointMode: Type.Optional(Type.Union([Type.Literal('fixed'), Type.Literal('pi-native-dynamic')])),
  resolvedEndpoint: Type.Optional(Type.Union([Type.String(), Type.Null()])), reasoning: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

/** 已保存的继承快照损坏时明确拒绝读取，不能把损坏解释为没有快照并套用新默认。 */
function initialModelFromColumn(value: string | null): CoordinatorModelConfig | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { /* 下方统一拒绝。 */ }
  if (!Check(InitialModelSchema, parsed)) throw new Error('子会话继承的模型快照损坏，不能改用全局默认，请核对恢复记录。');
  return parsed;
}

function sessionFromRow(row: SessionRow): SessionRecord {
  const origin = originFromColumn(row.origin_json);
  const initialModel = initialModelFromColumn(row.initial_model_json);
  return {
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    ...(row.host_book_id ? { host: { kind: 'reading' as const, bookId: row.host_book_id, title: row.host_book_title ?? '书籍已失效' } } : {}),
    ...(row.host_note_id ? { host: { kind: 'note' as const, noteId: row.host_note_id, title: row.host_note_title ?? '笔记不可用' } } : {}),
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at ?? row.created_at,
    archivedAt: row.archived_at,
    parentSessionId: row.parent_session_id,
    originText: origin?.text ?? null,
    workingDirectory: workingDirectoryFromColumns(row.working_directory_kind, row.working_directory_path),
    piSessionPath: row.pi_session_path,
    ...(initialModel ? { initialModel } : {}),
    origin,
  };
}

/**
 * Multivac 会话注册表的 SQLite 实现：会话标题、归属工作区、归档与工作目录。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteSessionRegistryRepository implements SessionRegistryRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(sessionId: string): SessionRecord | undefined {
    const row = this.database.prepare(`${SESSION_SELECT} WHERE r.session_id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  /** workspaceId 为 null 时跨全部工作区列出。 */
  list(workspaceId: string | null, kind: WorkspaceSessionKind, { includeArchived = false }: { includeArchived?: boolean } = {}): SessionRecord[] {
    const rows = this.database.prepare(`${SESSION_SELECT}
      WHERE (? IS NULL OR r.workspace_id = ?) AND r.kind = ? AND (? = 1 OR r.archived_at IS NULL)
        AND d.session_id IS NULL AND nd.session_id IS NULL
      ORDER BY r.created_at, r.session_id
    `).all(workspaceId, workspaceId, kind, includeArchived ? 1 : 0) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  insertIfAbsent(record: NewSessionRecord): { record: SessionRecord; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_session_registry
        (session_id, title, kind, workspace_id, created_at, archived_at, parent_session_id, origin_json,
         working_directory_kind, working_directory_path, initial_model_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      record.sessionId, record.title, record.kind, record.workspaceId, record.createdAt,
      record.parentSessionId ?? null, record.origin ? JSON.stringify(record.origin) : null,
      record.workingDirectory.kind, record.workingDirectory.path,
      record.initialModel ? JSON.stringify(record.initialModel) : null,
    );
    const winner = this.get(record.sessionId);
    if (!winner) throw new Error('Multivac 会话注册表写入后未能读取。');
    return { record: winner, inserted: result.changes === 1 };
  }

  rename(sessionId: string, title: string): SessionRecord | undefined {
    this.database.prepare('UPDATE assistant_session_registry SET title = ? WHERE session_id = ?')
      .run(title, sessionId);
    return this.get(sessionId);
  }

  archive(sessionId: string, archivedAt: string): SessionRecord | undefined {
    this.database.prepare(`
      UPDATE assistant_session_registry SET archived_at = COALESCE(archived_at, ?) WHERE session_id = ?
    `).run(archivedAt, sessionId);
    return this.get(sessionId);
  }

  /** 清除归档时间，会话回到原工作区；未归档的会话不变。 */
  restore(sessionId: string): SessionRecord | undefined {
    this.database.prepare('UPDATE assistant_session_registry SET archived_at = NULL WHERE session_id = ?')
      .run(sessionId);
    return this.get(sessionId);
  }

  /** 删除会话记录（仅供 E2E 重置空工作区；正常流程只归档，不删除）。 */
  deleteForTest(sessionId: string): void {
    this.database.prepare('DELETE FROM assistant_session_registry WHERE session_id = ?').run(sessionId);
  }

  listAll(): SessionRecord[] {
    const rows = this.database.prepare(`${SESSION_SELECT} ORDER BY r.created_at, r.session_id`)
      .all() as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  setWorkingDirectory(sessionId: string, workingDirectory: WorkingDirectory): SessionRecord | undefined {
    this.database.prepare(`
      UPDATE assistant_session_registry SET working_directory_kind = ?, working_directory_path = ? WHERE session_id = ?
    `).run(workingDirectory.kind, workingDirectory.path, sessionId);
    return this.get(sessionId);
  }

  /** 归入项目：工作区与工作目录在同一事务中更新；只改仍在原工作区、未归档的工作会话。 */
  moveToWorkspace(sessionId: string, move: SessionWorkspaceMove): SessionRecord | undefined {
    return runInTransaction(this.database, () => {
      const result = this.database.prepare(`
        UPDATE assistant_session_registry
        SET workspace_id = ?, working_directory_kind = ?, working_directory_path = ?
        WHERE session_id = ? AND workspace_id = ? AND kind = 'work' AND archived_at IS NULL
      `).run(
        move.toWorkspaceId, move.workingDirectory.kind, move.workingDirectory.path,
        sessionId, move.fromWorkspaceId,
      );
      return result.changes === 1 ? this.get(sessionId) : undefined;
    });
  }

  isWorkingDirectoryRecorded(path: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM assistant_session_registry WHERE working_directory_path = ? COLLATE NOCASE LIMIT 1
    `).get(path) !== undefined;
  }

  deleteIfUnbound(sessionId: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM assistant_session_registry
      WHERE session_id = ? AND NOT EXISTS (
        SELECT 1 FROM assistant_session_binding WHERE assistant_id = assistant_session_registry.session_id
      )
    `).run(sessionId);
    return result.changes === 1;
  }
}
