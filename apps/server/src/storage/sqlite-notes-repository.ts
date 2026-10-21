import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { NOTE_SUMMARIES_SELECT, NOTE_SUMMARY_SELECT, NOTE_SUMMARY_COUNT, NOTE_VERSION_SUMMARIES_SELECT, writeNoteSummaries } from './sqlite-note-summaries.js';
import { NoteSchema, NoteSummarySchema, UpdateNoteFieldsSchema, DeleteNoteSchema, type DeleteNote, type DeletedNote, type NoteVersionList, type Note, type NoteSummary, type CreateNote, type UpdateNoteFields } from '@multivac/contracts';
import { NotesError, notesFingerprint, type NotesRepository } from '../modules/notes/note.js';
import { SqliteNoteImagesRepository } from './sqlite-note-images-repository.js';
import { runInTransaction } from './sqlite-transaction.js';

/** 待处理建议因正文版本变化而失效时记录的原因。 */
const STALE_SUGGESTION_PROBLEM = '正文版本已变化，请基于当前正文重新生成建议。';

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
/** 活跃笔记索引也用于计数，删除标记不使容量检查重新扫描所有正文。 */
export const NOTE_DELETION_MIGRATION = `
  CREATE INDEX IF NOT EXISTS app_note_active ON app_note(id)
    WHERE json_extract(record_json, '$.deleted') IS NOT 1;
`;

/** 每次修改与版本快照、命令回执共用短事务；不在事务中调用模型或等待文件。 */
export class SqliteNotesRepository implements NotesRepository {
  constructor(readonly database: DatabaseSync) {}

  get(id: string, revision?: number): Note {
    const row = revision === undefined
      ? this.database.prepare('SELECT record_json FROM app_note WHERE id=?').get(id)
      : this.database.prepare('SELECT record_json FROM app_note_version WHERE note_id=? AND revision=?').get(id, revision);
    if (!row) throw new NotesError('笔记或正文版本不存在。', 404);
    const value: unknown = JSON.parse(String(row.record_json));
    if (value && typeof value === 'object' && 'deleted' in value && value.deleted === true) throw new NotesError('笔记已删除。', 404);
    if (!Check(NoteSchema, value)) throw new Error('独立笔记存储无效。');
    return value;
  }

  private readSummary(json: unknown): NoteSummary {
    const value: unknown = JSON.parse(String(json));
    if (!Check(NoteSummarySchema, value)) throw new Error('笔记摘要存储无效。');
    return value;
  }

  summary(id: string): NoteSummary {
    const row = this.database.prepare(NOTE_SUMMARY_SELECT).get(id);
    if (!row) throw new NotesError('笔记不存在。', 404);
    return this.readSummary(row.summary_json);
  }

  list(): NoteSummary[] {
    return this.database.prepare(NOTE_SUMMARIES_SELECT).all().map(row => this.readSummary(row.summary_json));
  }

  count(): number {
    return Number(this.database.prepare(NOTE_SUMMARY_COUNT).get()!.count);
  }

  versions(id: string, before?: number, limit = 20): NoteVersionList {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new NotesError('版本分页参数无效。');
    const latestRevision = this.summary(id).revision;
    const rows = this.database.prepare(NOTE_VERSION_SUMMARIES_SELECT).all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const versions = rows.slice(0, limit).map(row => this.readSummary(row.summary_json));
    return { versions, latestRevision, nextBefore: rows.length > limit ? versions.at(-1)!.revision : null };
  }

  /** 只读核对已提交的笔记命令，不重新执行，也不把当前正文冒充原回执。 */
  operation(commandId: string): Note | undefined {
    const row = this.database.prepare('SELECT result_json FROM app_note_command WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    const value: unknown = JSON.parse(String(row.result_json));
    if (value && typeof value === 'object' && ('deletedNoteId' in value || 'deleted' in value)) throw new NotesError('笔记已删除，原操作不能重放。', 410);
    if (!Check(NoteSchema, value)) throw new Error('笔记命令回执无效。');
    return value;
  }

  receipt<T>(commandId: string, fingerprint: string): T | undefined {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM app_note_command WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new NotesError('同一命令的参数发生变化，请核对原请求。', 409);
    const value: unknown = JSON.parse(String(row.result_json));
    if (value && typeof value === 'object' && 'deletedNoteId' in value) throw new NotesError('笔记已删除，原操作不能重放。', 410);
    return value as T;
  }

  command<T>(commandId: string, fingerprint: string, mutate: () => T): { value: T; changed: boolean } {
    return runInTransaction(this.database, () => {
      const receipt = this.receipt<T>(commandId, fingerprint);
      if (receipt !== undefined) { return { value: receipt, changed: false }; }
      const value = mutate();
      this.database.prepare('INSERT INTO app_note_command VALUES (?,?,?)').run(commandId, fingerprint, JSON.stringify(value));
      return { value, changed: true };
    });
  }

  /** 仅供本仓库及建议应用在已有事务中写入；每个正文版本不可变。 */
  writeVersion(note: Note): void {
    if (!Check(NoteSchema, note)) throw new NotesError('笔记内容超过限制或无效。');
    new SqliteNoteImagesRepository(this.database).retainReferences(note.id, note.body);
    this.database.prepare('INSERT INTO app_note VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(note.id, JSON.stringify(note));
    this.database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run(note.id, note.revision, JSON.stringify(note));
    writeNoteSummaries(this.database, note);
    // 正文版本变化使基于旧版本的待处理建议失效，与正文、版本快照同一事务提交。
    this.database.prepare(`UPDATE app_note_suggestion
      SET record_json=json_set(record_json, '$.status', 'stale', '$.problem', ?)
      WHERE note_id=? AND json_extract(record_json, '$.status')='pending' AND json_extract(record_json, '$.baseRevision')<>?`)
      .run(STALE_SUGGESTION_PROBLEM, note.id, note.revision);
  }

  create(input: CreateNote) {
    return this.command(input.commandId, notesFingerprint(['create', input]), () => {
      if (this.database.prepare('SELECT id FROM app_note WHERE id=?').get(input.id)) throw new NotesError('笔记身份已存在，请核对原新建请求。', 409);
      if (this.count() >= 1000) throw new NotesError('笔记库最多保存 1000 篇笔记。', 409);
      const now = new Date().toISOString();
      const note: Note = { id: input.id, title: input.title, body: input.body, revision: 1, createdAt: now, updatedAt: now };
      this.writeVersion(note); return note;
    });
  }

  remove(id: string, input: DeleteNote, check?: () => void) {
    if (!Check(DeleteNoteSchema, input)) throw new NotesError('删除笔记参数无效。');
    return this.command<DeletedNote>(input.commandId, notesFingerprint(['delete', id, input]), () => {
      const note = this.summary(id);
      if (note.revision !== input.expectedRevision) throw new NotesError('笔记版本已变化，请核对最新内容后再删除。', 409);
      check?.();
      // 先清理引用外键，再移除所有版本；只留下不含正文的身份标记，拒绝旧请求复活笔记。
      this.database.prepare(`DELETE FROM app_note_suggestion_source WHERE EXISTS (
        SELECT 1 FROM json_each(ids_json) source JOIN app_note_suggestion s ON s.id=source.value WHERE s.note_id=?)`).run(id);
      this.database.prepare('DELETE FROM app_note_suggestion WHERE note_id=?').run(id);
      this.database.prepare('DELETE FROM app_note_context WHERE note_id=?').run(id);
      this.database.prepare('DELETE FROM app_note_summary WHERE id=?').run(id);
      this.database.prepare('DELETE FROM app_note_version_summary WHERE note_id=?').run(id);
      this.database.prepare('DELETE FROM app_note_version WHERE note_id=?').run(id);
      this.database.prepare(`UPDATE app_note_command SET result_json=json_object('deletedNoteId',?)
        WHERE (json_extract(result_json, '$.id')=? AND json_type(result_json, '$.body')='text')
          OR EXISTS (SELECT 1 FROM json_tree(result_json) WHERE key='noteId' AND atom=?)`).run(id, id, id);
      this.database.prepare(`UPDATE assistant_session_registry SET archived_at=COALESCE(archived_at,?), title='已删除笔记'
        WHERE session_id IN (SELECT session_id FROM app_note_discussion WHERE note_id=?)`).run(new Date().toISOString(), id);
      this.database.prepare(`UPDATE app_note_discussion SET record_json=json_set(record_json, '$.title','已删除笔记','$.topic',json('null')) WHERE note_id=?`).run(id);
      this.database.prepare('UPDATE app_note SET record_json=? WHERE id=?').run(JSON.stringify({ id, deleted: true }), id);
      return { id, deleted: true };
    });
  }

  update(id: string, input: UpdateNoteFields) {
    if (!Check(UpdateNoteFieldsSchema, input)) throw new NotesError('至少指定标题或 Markdown 正文，参数须符合笔记限制。');
    return this.command(input.commandId, notesFingerprint(['update', id, input]), () => {
      const current = this.get(id);
      if (current.revision !== input.expectedRevision) throw new NotesError('笔记已被另一窗口修改，未覆盖新内容；请读取最新版本并核对后继续。', 409);
      const title = input.title ?? current.title;
      const body = input.body ?? current.body;
      if (current.title === title && current.body === body) return current;
      const note = { ...current, title, body, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.writeVersion(note); return note;
    });
  }
}
