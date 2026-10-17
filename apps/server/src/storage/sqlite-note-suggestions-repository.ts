import { Check } from 'typebox/value';
import { NoteSuggestionSchema, type NoteSuggestion, type Note } from '@multivac/contracts';
import type { SqliteNotesRepository } from './sqlite-notes-repository.js';
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
  constructor(readonly notes: SqliteNotesRepository) { notes.versionChanged = note => this.invalidate(note); }
  get(id: string): NoteSuggestion {
    const row = this.notes.database.prepare('SELECT record_json FROM app_note_suggestion WHERE id=?').get(id);
    if (!row) throw new NotesError('修改建议不存在。', 404);
    const value: unknown = JSON.parse(String(row.record_json));
    if (!Check(NoteSuggestionSchema, value)) throw new Error('修改建议存储无效。');
    return value;
  }
  list(noteId: string, sessionId?: string): NoteSuggestion[] {
    return this.notes.database.prepare('SELECT id FROM app_note_suggestion WHERE note_id=? AND (? IS NULL OR session_id=?) ORDER BY rowid').all(noteId, sessionId ?? null, sessionId ?? null).map(row => this.get(String(row.id)));
  }
  source(key: string): NoteSuggestion[] | null {
    const row = this.notes.database.prepare('SELECT ids_json FROM app_note_suggestion_source WHERE source_key=?').get(key);
    return row ? (JSON.parse(String(row.ids_json)) as string[]).map(id => this.get(id)) : null;
  }
  insertSource(key: string, suggestions: NoteSuggestion[]) {
    if (suggestions[0] && this.list(suggestions[0].noteId).length + suggestions.length > 2000) throw new NotesError('每篇笔记最多保存2000条修改建议。', 409);
    for (const item of suggestions) this.notes.database.prepare('INSERT INTO app_note_suggestion VALUES (?,?,?,?)').run(item.id, item.noteId, item.sessionId, JSON.stringify(item));
    this.notes.database.prepare('INSERT INTO app_note_suggestion_source VALUES (?,?)').run(key, JSON.stringify(suggestions.map(s => s.id)));
  }
  put(suggestion: NoteSuggestion) {
    if (!Check(NoteSuggestionSchema, suggestion)) throw new Error('修改建议无效。');
    this.notes.database.prepare('UPDATE app_note_suggestion SET record_json=? WHERE id=?').run(JSON.stringify(suggestion), suggestion.id);
  }
  private invalidate(note: Note) {
    for (const suggestion of this.list(note.id)) {
      if (suggestion.status === 'pending' && suggestion.baseRevision !== note.revision) this.put({ ...suggestion, status: 'stale', problem: '正文版本已变化，请基于当前正文重新生成建议。' });
    }
  }
}
