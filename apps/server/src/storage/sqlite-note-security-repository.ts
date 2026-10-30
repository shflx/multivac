import type { DatabaseSync } from 'node:sqlite';
import type { NoteSecurityRepository } from '../modules/notes/security-repository.js';
import type { NotePasswordRecord, NoteSealedKey } from '../modules/notes/note-crypto.js';
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

/**
 * 旧版主密钥记录无法转换为密钥对。仅当没有任何笔记处于加密或转换中时，清除旧密码与遗留逐篇密钥，
 * 由用户重新设置密码；仍有加密笔记时保持原样，避免锁死已有密文。
 */
export const NOTE_KEYPAIR_MIGRATION = `
  DELETE FROM app_note_key WHERE EXISTS (SELECT 1 FROM app_note_password WHERE json_extract(record_json,'$.format') IS NOT 2)
    AND NOT EXISTS (SELECT 1 FROM app_note_protection);
  DELETE FROM app_note_password WHERE json_extract(record_json,'$.format') IS NOT 2
    AND NOT EXISTS (SELECT 1 FROM app_note_protection);
`;

/** 密码记录用版本比较后原子替换；数据库失败时旧密码记录保持可用。 */
export class SqliteNoteSecurityRepository implements NoteSecurityRepository {
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
  key(noteId: string): NoteSealedKey | undefined {
    const row = this.database.prepare('SELECT record_json FROM app_note_key WHERE note_id=?').get(noteId);
    return row ? JSON.parse(String(row.record_json)) as NoteSealedKey : undefined;
  }
  insertKey(noteId: string, key: NoteSealedKey): void {
    this.database.prepare('INSERT INTO app_note_key VALUES (?,?)').run(noteId, JSON.stringify(key));
  }
}
