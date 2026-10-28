import type { NoteRecordCodec } from './note-record-codec.js';
import { Check } from 'typebox/value';
import { NoteSuggestionSchema, type NoteSuggestion } from '@multivac/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { NotesError, type NoteSuggestionsRepository } from '../modules/notes/note.js';

export const NOTE_SUGGESTIONS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS app_note_suggestion (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES app_note(id),
    session_id TEXT NOT NULL REFERENCES app_note_discussion(session_id), record_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS app_note_suggestion_note ON app_note_suggestion(note_id);
  CREATE TABLE IF NOT EXISTS app_note_suggestion_source (
    source_key TEXT PRIMARY KEY, ids_json TEXT NOT NULL
  ) STRICT;
`;
export class SqliteNoteSuggestionsRepository implements NoteSuggestionsRepository {
  /** 与笔记仓储共用连接；写入只在笔记命令事务内发生，失效由笔记版本写入同事务完成。 */
  constructor(private readonly database: DatabaseSync, private readonly codec?: NoteRecordCodec) {}
  get(id: string): NoteSuggestion {
    const row = this.database.prepare('SELECT note_id,record_json FROM app_note_suggestion WHERE id=?').get(id);
    if (!row) throw new NotesError('修改建议不存在。', 404);
    const value: unknown = this.codec?.decode(String(row.note_id), 'suggestion', id, row.record_json) ?? JSON.parse(String(row.record_json));
    if (!Check(NoteSuggestionSchema, value)) throw new Error('修改建议存储无效。');
    return value;
  }
  list(noteId: string, sessionId?: string): NoteSuggestion[] {
    return this.database.prepare('SELECT id FROM app_note_suggestion WHERE note_id=? AND (? IS NULL OR session_id=?) ORDER BY rowid').all(noteId, sessionId ?? null, sessionId ?? null).map(row => this.get(String(row.id)));
  }
  source(key: string): NoteSuggestion[] | null {
    const row = this.database.prepare('SELECT ids_json FROM app_note_suggestion_source WHERE source_key=?').get(key);
    return row ? (JSON.parse(String(row.ids_json)) as string[]).map(id => this.get(id)) : null;
  }
  insertSource(key: string, suggestions: NoteSuggestion[]) {
    if (suggestions[0] && this.list(suggestions[0].noteId).length + suggestions.length > 2000) throw new NotesError('每篇笔记最多保存2000条修改建议。', 409);
    for (const item of suggestions) this.database.prepare('INSERT INTO app_note_suggestion VALUES (?,?,?,?)').run(item.id, item.noteId, item.sessionId, this.codec?.encode(item.noteId, 'suggestion', item.id, item) ?? JSON.stringify(item));
    this.database.prepare('INSERT INTO app_note_suggestion_source VALUES (?,?)').run(key, JSON.stringify(suggestions.map(s => s.id)));
  }
  put(suggestion: NoteSuggestion) {
    if (!Check(NoteSuggestionSchema, suggestion)) throw new Error('修改建议无效。');
    this.database.prepare('UPDATE app_note_suggestion SET record_json=? WHERE id=?').run(this.codec?.encode(suggestion.noteId, 'suggestion', suggestion.id, suggestion) ?? JSON.stringify(suggestion), suggestion.id);
  }
}
