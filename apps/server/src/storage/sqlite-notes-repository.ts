import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { NoteSchema, type Note, type NoteSummary, type CreateNote, type UpdateNote } from '@multivac/contracts';

export class NotesError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const NOTES_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note (
    id TEXT PRIMARY KEY, record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS app_note_version (
    note_id TEXT NOT NULL REFERENCES app_note(id), revision INTEGER NOT NULL,
    record_json TEXT NOT NULL, PRIMARY KEY(note_id, revision)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS app_note_command (
    command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
  ) STRICT;
`;
export function notesFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 每次修改与版本快照、命令回执共用短事务；不在事务中调用模型或等待文件。 */
export class SqliteNotesRepository {
  /** 同事务内通知建议仓库正文版本变化；不发布外部事件或执行异步操作。 */
  versionChanged?: (note: Note) => void;
  constructor(readonly database: DatabaseSync) {}

  get(id: string, revision?: number): Note {
    const row = revision === undefined
      ? this.database.prepare('SELECT record_json FROM app_note WHERE id=?').get(id)
      : this.database.prepare('SELECT record_json FROM app_note_version WHERE note_id=? AND revision=?').get(id, revision);
    if (!row) throw new NotesError('笔记或正文版本不存在。', 404);
    const value: unknown = JSON.parse(String(row.record_json));
    if (!Check(NoteSchema, value)) throw new Error('独立笔记存储无效。');
    return value;
  }

  list(): NoteSummary[] {
    const rows = this.database.prepare(`SELECT id FROM app_note ORDER BY json_extract(record_json, '$.updatedAt') DESC, id`).all();
    return rows.map(row => { const { body: _body, ...summary } = this.get(String(row.id)); return summary; });
  }

  receipt<T>(commandId: string, fingerprint: string): T | undefined {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM app_note_command WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new NotesError('同一命令的参数发生变化，请核对原请求。', 409);
    return JSON.parse(String(row.result_json)) as T;
  }

  command<T>(commandId: string, fingerprint: string, mutate: () => T): { value: T; changed: boolean } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.receipt<T>(commandId, fingerprint);
      if (receipt !== undefined) { this.database.exec('COMMIT'); return { value: receipt, changed: false }; }
      const value = mutate();
      this.database.prepare('INSERT INTO app_note_command VALUES (?,?,?)').run(commandId, fingerprint, JSON.stringify(value));
      this.database.exec('COMMIT');
      return { value, changed: true };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  /** 仅供本仓库及建议应用在已有事务中写入；每个正文版本不可变。 */
  writeVersion(note: Note): void {
    if (!Check(NoteSchema, note)) throw new NotesError('笔记内容超过限制或无效。');
    this.database.prepare('INSERT INTO app_note VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(note.id, JSON.stringify(note));
    this.database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run(note.id, note.revision, JSON.stringify(note));
    this.versionChanged?.(note);
  }

  create(input: CreateNote) {
    return this.command(input.commandId, notesFingerprint(['create', input]), () => {
      if (this.database.prepare('SELECT id FROM app_note WHERE id=?').get(input.id)) throw new NotesError('笔记身份已存在，请核对原新建请求。', 409);
      if (this.list().length >= 1000) throw new NotesError('笔记库最多保存 1000 篇笔记。', 409);
      const now = new Date().toISOString();
      const note: Note = { id: input.id, title: input.title, body: input.body, revision: 1, createdAt: now, updatedAt: now };
      this.writeVersion(note); return note;
    });
  }

  update(id: string, input: UpdateNote) {
    return this.command(input.commandId, notesFingerprint(['update', id, input]), () => {
      const current = this.get(id);
      if (current.revision !== input.expectedRevision) throw new NotesError('笔记已被另一窗口修改。本机草稿已保留，请核对最新版本后继续。', 409);
      if (current.title === input.title && current.body === input.body) return current;
      const note = { ...current, title: input.title, body: input.body, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.writeVersion(note); return note;
    });
  }
}
