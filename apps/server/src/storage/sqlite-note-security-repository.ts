import type { DatabaseSync } from 'node:sqlite';
import type { NoteCiphertext, NotePasswordRecord } from '../modules/notes/note-crypto.js';
import { NotesError } from '../modules/notes/note.js';
import { runInTransaction } from './sqlite-transaction.js';

export const NOTE_SECURITY_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_password (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, record_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS app_note_key (
    note_id TEXT PRIMARY KEY, record_json TEXT NOT NULL
  ) STRICT;
`;

/** 密码记录用版本比较后原子替换；数据库失败时旧密码记录保持可用。 */
export class SqliteNoteSecurityRepository {
  constructor(readonly database: DatabaseSync) {}
  password(): NotePasswordRecord | undefined {
    const row = this.database.prepare('SELECT record_json FROM app_note_password WHERE singleton=1').get();
    return row ? JSON.parse(String(row.record_json)) as NotePasswordRecord : undefined;
  }
  replacePassword(expectedRevision: number, record: NotePasswordRecord): void {
    runInTransaction(this.database, () => {
      const current = this.password();
      if ((current?.revision ?? 0) !== expectedRevision || record.revision !== expectedRevision + 1) throw new NotesError('密码设置已变化，请使用当前密码重试。', 409);
      this.database.prepare('INSERT INTO app_note_password VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json')
        .run(record.revision, JSON.stringify(record));
    });
  }
  key(noteId: string): NoteCiphertext | undefined {
    const row = this.database.prepare('SELECT record_json FROM app_note_key WHERE note_id=?').get(noteId);
    return row ? JSON.parse(String(row.record_json)) as NoteCiphertext : undefined;
  }
  insertKey(noteId: string, key: NoteCiphertext): void {
    this.database.prepare('INSERT INTO app_note_key VALUES (?,?)').run(noteId, JSON.stringify(key));
  }
}
