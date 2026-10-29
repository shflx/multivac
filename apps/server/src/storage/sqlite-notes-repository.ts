import type { NoteRecordCodec } from './note-record-codec.js';
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
  constructor(readonly database: DatabaseSync, readonly codec?: NoteRecordCodec) {}

  get(id: string, revision?: number): Note {
    const row = revision === undefined
      ? this.database.prepare('SELECT record_json FROM app_note WHERE id=?').get(id)
      : this.database.prepare('SELECT record_json FROM app_note_version WHERE note_id=? AND revision=?').get(id, revision);
    if (!row) throw new NotesError('笔记或正文版本不存在。', 404);
    const value: unknown = this.codec?.decode(id, revision === undefined ? 'note' : 'version', revision === undefined ? id : String(revision), row.record_json) ?? JSON.parse(String(row.record_json));
    if (value && typeof value === 'object' && 'deleted' in value && value.deleted === true) throw new NotesError('笔记已删除。', 404);
    if (!Check(NoteSchema, value)) throw new Error('独立笔记存储无效。');
    return value;
  }

  private readSummary(json: unknown, id: string, revision?: number): NoteSummary {
    const value: unknown = this.codec?.decode(id, revision === undefined ? 'summary' : 'version-summary', revision === undefined ? id : String(revision), json) ?? JSON.parse(String(json));
    if (!Check(NoteSummarySchema, value)) throw new Error('笔记摘要存储无效。');
    return value;
  }

  summary(id: string): NoteSummary {
    const row = this.database.prepare(NOTE_SUMMARY_SELECT).get(id);
    if (!row) throw new NotesError('笔记不存在。', 404);
    return this.readSummary(row.summary_json, id);
  }

  list(): NoteSummary[] {
    return this.database.prepare(NOTE_SUMMARIES_SELECT).all().map(row => {
      const id = String(row.id), protection = this.codec?.state(id);
      return protection ? { id, title: '加密笔记', revision: 1, createdAt: '', updatedAt: '', protection } : this.readSummary(row.summary_json, id);
    });
  }

  count(): number {
    return Number(this.database.prepare(NOTE_SUMMARY_COUNT).get()!.count);
  }

  versions(id: string, before?: number, limit = 20): NoteVersionList {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new NotesError('版本分页参数无效。');
    const latestRevision = this.summary(id).revision;
    const rows = this.database.prepare(NOTE_VERSION_SUMMARIES_SELECT).all(id, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const versions = rows.slice(0, limit).map(row => this.readSummary(row.summary_json, id, Number(row.revision)));
    return { versions, latestRevision, nextBefore: rows.length > limit ? versions.at(-1)!.revision : null };
  }

  /** 只读核对已提交的笔记命令，不重新执行，也不把当前正文冒充原回执。 */
  operation(commandId: string): Note | undefined {
    const row = this.database.prepare('SELECT note_id,result_json FROM app_note_command WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    const value: unknown = row.note_id && this.codec ? this.codec.decode(String(row.note_id), 'command', commandId, row.result_json) : JSON.parse(String(row.result_json));
    if (value && typeof value === 'object' && ('deletedNoteId' in value || 'deleted' in value)) throw new NotesError('笔记已删除，原操作不能重放。', 410);
    if (!Check(NoteSchema, value)) throw new Error('笔记命令回执无效。');
    return value;
  }

  receipt<T>(commandId: string, fingerprint: string): T | undefined {
    const row = this.database.prepare('SELECT note_id,fingerprint,result_json FROM app_note_command WHERE command_id=?').get(commandId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new NotesError('同一命令的参数发生变化，请核对原请求。', 409);
    const value: unknown = row.note_id && this.codec ? this.codec.decode(String(row.note_id), 'command', commandId, row.result_json) : JSON.parse(String(row.result_json));
    if (value && typeof value === 'object' && 'deletedNoteId' in value) throw new NotesError('笔记已删除，原操作不能重放。', 410);
    return value as T;
  }

  command<T>(commandId: string, fingerprint: string, mutate: () => T): { value: T; changed: boolean } {
    return runInTransaction(this.database, () => {
      const receipt = this.receipt<T>(commandId, fingerprint);
      if (receipt !== undefined) { return { value: receipt, changed: false }; }
      const value = mutate();
      const owner = this.commandOwner(value);
      const json = owner && this.codec ? this.codec.encode(owner, 'command', commandId, value) : JSON.stringify(value);
      this.database.prepare('INSERT INTO app_note_command(command_id,fingerprint,result_json,note_id) VALUES (?,?,?,?)').run(commandId, fingerprint, json, owner ?? null);
      return { value, changed: true };
    });
  }

  private commandOwner(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    if (Array.isArray(value)) return value.map(item => this.commandOwner(item)).find(Boolean);
    const record = value as Record<string, unknown>;
    if (typeof record.noteId === 'string') return record.noteId;
    if (typeof record.id === 'string' && ('body' in record || 'deleted' in record)) return record.id;
    return Object.values(record).map(item => this.commandOwner(item)).find(Boolean);
  }

  /** 仅供本仓库及建议应用在已有事务中写入；每个正文版本不可变。 */
  writeVersion(note: Note): void {
    if (!Check(NoteSchema, note)) throw new NotesError('笔记内容超过限制或无效。');
    const existing = this.database.prepare("SELECT id FROM app_note WHERE id=? AND json_extract(record_json,'$.deleted')=1").get(note.id);
    if (existing) throw new NotesError('笔记已删除，不能重新写入正文版本。', 404);
    new SqliteNoteImagesRepository(this.database, this.codec).retainReferences(note.id, note.body);
    this.database.prepare('INSERT INTO app_note VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(note.id, this.codec?.encode(note.id, 'note', note.id, note) ?? JSON.stringify(note));
    this.database.prepare('INSERT INTO app_note_version VALUES (?,?,?)').run(note.id, note.revision, this.codec?.encode(note.id, 'version', String(note.revision), note) ?? JSON.stringify(note));
    writeNoteSummaries(this.database, note, this.codec);
    // 正文版本变化使基于旧版本的待处理建议失效，与正文、版本快照同一事务提交。
    if (this.codec?.state(note.id)) {
      for (const row of this.database.prepare('SELECT id,record_json FROM app_note_suggestion WHERE note_id=?').all(note.id)) {
        const suggestion = this.codec.decode<Record<string, unknown>>(note.id, 'suggestion', String(row.id), row.record_json);
        if (suggestion.status === 'pending' && suggestion.baseRevision !== note.revision) {
          this.database.prepare('UPDATE app_note_suggestion SET record_json=? WHERE id=?').run(this.codec.encode(note.id, 'suggestion', String(row.id), { ...suggestion, status: 'stale', problem: STALE_SUGGESTION_PROBLEM }), row.id!);
        }
      }
    } else {
      this.database.prepare(`UPDATE app_note_suggestion
        SET record_json=json_set(record_json, '$.status', 'stale', '$.problem', ?)
        WHERE note_id=? AND json_extract(record_json, '$.status')='pending' AND json_extract(record_json, '$.baseRevision')<>?`)
        .run(STALE_SUGGESTION_PROBLEM, note.id, note.revision);
    }
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
