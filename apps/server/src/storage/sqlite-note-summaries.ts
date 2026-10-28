import type { NoteRecordCodec } from './note-record-codec.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Note } from '@multivac/contracts';

/** 摘要是正文的事务内投影；仅升级时回填，普通查询不补写，也不读取正文记录。 */
export const NOTE_SUMMARY_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_summary (
    id TEXT PRIMARY KEY REFERENCES app_note(id), updated_at TEXT NOT NULL, summary_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS app_note_summary_order ON app_note_summary(updated_at DESC, id);
  CREATE TABLE IF NOT EXISTS app_note_version_summary (
    note_id TEXT NOT NULL, revision INTEGER NOT NULL, summary_json TEXT NOT NULL,
    PRIMARY KEY(note_id, revision),
    FOREIGN KEY(note_id, revision) REFERENCES app_note_version(note_id, revision) ON DELETE CASCADE
  ) STRICT;

  -- 重放只重建派生摘要，不改动正文、不可变版本和命令回执。
  DELETE FROM app_note_summary;
  DELETE FROM app_note_version_summary;
  INSERT INTO app_note_summary(id, updated_at, summary_json)
    SELECT id, json_extract(record_json, '$.updatedAt'), json_remove(record_json, '$.body')
    FROM app_note WHERE json_extract(record_json, '$.deleted') IS NOT 1;
  INSERT INTO app_note_version_summary(note_id, revision, summary_json)
    SELECT note_id, revision, json_remove(record_json, '$.body') FROM app_note_version;
`;

export const NOTE_SUMMARIES_SELECT = 'SELECT id,summary_json FROM app_note_summary ORDER BY updated_at DESC, id';
export const NOTE_SUMMARY_SELECT = 'SELECT id,summary_json FROM app_note_summary WHERE id=?';
export const NOTE_SUMMARY_COUNT = 'SELECT COUNT(*) AS count FROM app_note_summary';
export const NOTE_VERSION_SUMMARIES_SELECT = `SELECT note_id,revision,summary_json FROM app_note_version_summary
  WHERE note_id=? AND revision<? ORDER BY revision DESC LIMIT ?`;

/** 调用者已在正文版本的同一事务中；这里不建立另一套提交或重试边界。 */
export function writeNoteSummaries(database: DatabaseSync, note: Note, codec?: NoteRecordCodec): void {
  const { body: _body, ...summary } = note;
  const json = codec?.encode(note.id, 'summary', note.id, summary) ?? JSON.stringify(summary);
  const versionJson = codec?.encode(note.id, 'version-summary', String(note.revision), summary) ?? JSON.stringify(summary);
  database.prepare(`INSERT INTO app_note_summary(id, updated_at, summary_json) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, summary_json=excluded.summary_json`).run(note.id, note.updatedAt, json);
  database.prepare('INSERT INTO app_note_version_summary(note_id, revision, summary_json) VALUES (?,?,?)').run(note.id, note.revision, versionJson);
}
