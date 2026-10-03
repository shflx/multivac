import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { ReadingNotesStateSchema, hasUnsavedReadingNote, type ReadingNotesState, type ReadingNotesCommand } from '@multivac/contracts';
import { ReadingError, readingHash } from '../modules/reading/book-import.js';

export const READING_NOTES_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_notes_state (book_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_notes_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export class SqliteReadingNotesRepository {
  constructor(private readonly database: DatabaseSync) {}
  receipt(bookId: string, command: ReadingNotesCommand): ReadingNotesState | null {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM reading_notes_command WHERE command_id=?').get(command.commandId);
    if (!row) return null;
    if (row.fingerprint !== readingHash(JSON.stringify([bookId, command]))) throw new ReadingError('命令参数冲突。', 409);
    return JSON.parse(String(row.result_json));
  }
  get(bookId: string): ReadingNotesState {
    const row = this.database.prepare('SELECT record_json FROM reading_notes_state WHERE book_id=?').get(bookId);
    const value: unknown = row ? JSON.parse(String(row.record_json)) : { bookId, revision: 0, notes: [], draft: null };
    if (!Check(ReadingNotesStateSchema, value)) throw new Error('阅读笔记存储契约无效。');
    return value;
  }
  mutate(bookId: string, command: ReadingNotesCommand, validate: () => void): { state: ReadingNotesState; changed: boolean } {
    const fingerprint = readingHash(JSON.stringify([bookId, command]));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.database.prepare('SELECT fingerprint,result_json FROM reading_notes_command WHERE command_id=?').get(command.commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ReadingError('命令参数冲突。', 409);
        this.database.exec('COMMIT'); return { state: JSON.parse(String(receipt.result_json)), changed: false };
      }
      const current = this.get(bookId);
      if (current.revision !== command.expectedRevision) throw new ReadingError('笔记或草稿已被其他窗口修改，当前草稿已保留，请核对后继续。', 409);
      validate();
      const state = { ...current, revision: current.revision + 1 };
      if (command.action === 'draft') {
        if (current.draft && current.draft.id !== command.draft?.id && hasUnsavedReadingNote(current) && !command.discardExisting) throw new ReadingError('请先保存、放弃或继续原草稿。', 409);
        state.draft = command.draft;
      } else if (command.action === 'save') {
        const draft = current.draft;
        if (!draft?.body.trim()) throw new ReadingError('笔记内容不能为空。');
        const existing = current.notes.find(n => n.id === draft.id);
        if (!existing && current.notes.length >= 200) throw new ReadingError('每本书最多 200 条阅读笔记。', 409);
        const note = { ...draft, body: draft.body.trim(), revision: (existing?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
        state.notes = [...current.notes.filter(n => n.id !== note.id), note];
        state.draft = command.nextDraft ?? null;
      } else {
        if (!current.notes.some(n => n.id === command.id)) throw new ReadingError('笔记已删除。', 404);
        if (current.draft?.id === command.id && hasUnsavedReadingNote(current)) throw new ReadingError('当前笔记有未保存修改，请先处理草稿。', 409);
        state.notes = current.notes.filter(n => n.id !== command.id);
        if (state.draft?.id === command.id) state.draft = null;
      }
      this.database.prepare('INSERT INTO reading_notes_state VALUES (?,?) ON CONFLICT(book_id) DO UPDATE SET record_json=excluded.record_json').run(bookId, JSON.stringify(state));
      this.database.prepare('INSERT INTO reading_notes_command VALUES (?,?,?)').run(command.commandId, fingerprint, JSON.stringify(state));
      this.database.exec('COMMIT'); return { state, changed: true };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
