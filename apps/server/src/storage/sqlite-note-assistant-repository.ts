import { Check } from 'typebox/value';
import { NoteDiscussionSchema, NoteSnapshotSchema, type NoteDiscussion, type NoteSnapshot, type CoordinatorModelConfig } from '@multivac/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { NotesError, type NoteAssistantRepository } from '../modules/notes/note.js';

export const NOTE_ASSISTANT_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_discussion (
    session_id TEXT PRIMARY KEY REFERENCES assistant_session_registry(session_id),
    note_id TEXT NOT NULL REFERENCES app_note(id), record_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS app_note_discussion_note ON app_note_discussion(note_id);
  CREATE TABLE IF NOT EXISTS app_note_context (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES app_note_discussion(session_id),
    note_id TEXT NOT NULL, revision INTEGER NOT NULL, record_json TEXT NOT NULL,
    FOREIGN KEY(note_id,revision) REFERENCES app_note_version(note_id,revision)
  ) STRICT;
`;
export class SqliteNoteAssistantRepository implements NoteAssistantRepository {
  /** 与笔记仓储共用连接；写入只在笔记命令事务内发生。 */
  constructor(private readonly database: DatabaseSync) {}
  discussion(id: string): NoteDiscussion | null {
    const row = this.database.prepare('SELECT record_json FROM app_note_discussion WHERE session_id=?').get(id);
    if (!row) return null;
    const value: unknown = JSON.parse(String(row.record_json));
    if (!Check(NoteDiscussionSchema, value)) throw new Error('笔记讨论存储无效。');
    return value;
  }
  discussions(noteId: string): NoteDiscussion[] {
    return this.database.prepare('SELECT session_id FROM app_note_discussion WHERE note_id=? ORDER BY rowid').all(noteId).map(row => this.discussion(String(row.session_id))!);
  }
  insertDiscussion(discussion: NoteDiscussion, directory: string, initialModel?: CoordinatorModelConfig) {
    if (this.database.prepare('SELECT session_id FROM assistant_session_registry WHERE session_id=?').get(discussion.sessionId)) throw new NotesError('讨论身份已存在。', 409);
    if (this.discussions(discussion.noteId).length >= 100) throw new NotesError('每篇笔记最多 100 个讨论。', 409);
    this.database.prepare(`INSERT INTO assistant_session_registry (session_id,title,kind,workspace_id,created_at,archived_at,parent_session_id,origin_json,working_directory_kind,working_directory_path,initial_model_json) VALUES (?,?,'work','default',?,NULL,?,NULL,'session-temp',?,?)`).run(discussion.sessionId, discussion.title, discussion.createdAt, discussion.parentSessionId, directory, initialModel ? JSON.stringify(initialModel) : null);
    this.database.prepare('INSERT INTO app_note_discussion VALUES (?,?,?)').run(discussion.sessionId, discussion.noteId, JSON.stringify(discussion));
  }
  snapshot(id: string): NoteSnapshot {
    const row = this.database.prepare('SELECT record_json FROM app_note_context WHERE id=?').get(id);
    if (!row) throw new NotesError('本轮笔记快照不存在。', 404);
    const value: unknown = JSON.parse(String(row.record_json));
    if (!Check(NoteSnapshotSchema, value)) throw new Error('笔记上下文存储无效。');
    return value;
  }
  insertSnapshot(snapshot: NoteSnapshot) {
    if (this.database.prepare('SELECT id FROM app_note_context WHERE id=?').get(snapshot.id)) throw new NotesError('笔记快照身份已存在。', 409);
    this.database.prepare('INSERT INTO app_note_context VALUES (?,?,?,?,?)').run(snapshot.id, snapshot.sessionId, snapshot.noteId, snapshot.revision, JSON.stringify(snapshot));
  }
}
