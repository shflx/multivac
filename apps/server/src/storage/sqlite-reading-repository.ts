import { SqliteBookContent } from './sqlite-book-content.js';
import type { BookIndex } from '@multivac/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { BookSchema, ReadingAnnotationSchema, type Book, type BookSummary, type ReadingAnnotation, type AnnotationCommand, type ReadingScope, type ReadingScopeCommand, type ReadingDiscussion } from '@multivac/contracts';
import { ReadingError } from '../modules/reading/book-import.js';

export const READING_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_book (book_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES reading_book(book_id)) STRICT;
`;
export const READING_ANNOTATION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_annotation (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS reading_annotation_book ON reading_annotation(book_id);
  CREATE TABLE IF NOT EXISTS reading_annotation_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export const READING_COMPANION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_scope (book_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_scope_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reading_discussion (session_id TEXT PRIMARY KEY, book_id TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS reading_discussion_book ON reading_discussion(book_id);
`;
export const READING_DISCUSSION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reading_discussion_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, session_id TEXT NOT NULL) STRICT;
`;
export class SqliteReadingRepository {
  readonly content: SqliteBookContent;
  constructor(private readonly database: DatabaseSync) { this.content = new SqliteBookContent(database); }
  scope(book: BookSummary): ReadingScope {
    const row = this.database.prepare('SELECT record_json FROM reading_scope WHERE book_id=?').get(book.id);
    return row ? JSON.parse(String(row.record_json)) : { bookId: book.id, version: book.version, revision: 0, boundary: null };
  }
  setScope(book: BookSummary, command: ReadingScopeCommand, fingerprint: string): { scope: ReadingScope; changed: boolean } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.database.prepare('SELECT fingerprint,result_json FROM reading_scope_command WHERE command_id=?').get(command.commandId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ReadingError('命令参数冲突。', 409);
        this.database.exec('COMMIT'); return { scope: JSON.parse(String(receipt.result_json)), changed: false };
      }
      const current = this.scope(book);
      if (current.revision !== command.expectedRevision) throw new ReadingError('已读范围已改变，请重新读取。', 409);
      const scope = { ...current, revision: current.revision + 1, boundary: command.boundary };
      this.database.prepare('INSERT INTO reading_scope VALUES (?,?) ON CONFLICT(book_id) DO UPDATE SET record_json=excluded.record_json').run(book.id, JSON.stringify(scope));
      this.database.prepare('INSERT INTO reading_scope_command VALUES (?,?,?)').run(command.commandId, fingerprint, JSON.stringify(scope));
      this.database.exec('COMMIT'); return { scope, changed: true };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  discussion(sessionId: string): ReadingDiscussion | null {
    const row = this.database.prepare('SELECT record_json FROM reading_discussion WHERE session_id=?').get(sessionId);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  discussions(bookId: string): ReadingDiscussion[] {
    return this.database.prepare('SELECT record_json FROM reading_discussion WHERE book_id=? ORDER BY rowid').all(bookId).map(row => JSON.parse(String(row.record_json)));
  }
  allDiscussions(): ReadingDiscussion[] {
    return this.database.prepare('SELECT record_json FROM reading_discussion ORDER BY rowid DESC LIMIT 20000').all().map(row => JSON.parse(String(row.record_json)));
  }
  discussionReceipt(commandId: string, fingerprint: string): ReadingDiscussion | null {
    const row = this.database.prepare('SELECT fingerprint,session_id FROM reading_discussion_command WHERE command_id=?').get(commandId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ReadingError('讨论命令参数冲突。', 409);
    return this.discussion(String(row.session_id));
  }
  createDiscussion(discussion: ReadingDiscussion, directory: string, commandId: string, fingerprint: string): ReadingDiscussion {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.discussionReceipt(commandId, fingerprint);
      if (receipt) { this.database.exec('COMMIT'); return receipt; }
      if (this.discussion(discussion.sessionId)) throw new ReadingError('讨论身份已存在。', 409);
      if (this.discussions(discussion.bookId).length >= 100) throw new ReadingError('每本书最多 100 个讨论。', 409);
      const parent = this.discussion(discussion.parentSessionId!);
      if (!parent || parent.bookId !== discussion.bookId) throw new ReadingError('父讨论已失效。', 409);
      this.database.prepare('INSERT INTO reading_discussion VALUES (?,?,?)').run(discussion.sessionId, discussion.bookId, JSON.stringify(discussion));
      this.database.prepare(`INSERT INTO assistant_session_registry (session_id,title,kind,workspace_id,created_at,archived_at,parent_session_id,origin_json,working_directory_kind,working_directory_path) VALUES (?,?,'work','default',?,NULL,?,NULL,'session-temp',?)`).run(discussion.sessionId, discussion.title, discussion.createdAt, discussion.parentSessionId, directory);
      this.database.prepare('INSERT INTO reading_discussion_command VALUES (?,?,?)').run(commandId, fingerprint, discussion.sessionId);
      this.database.exec('COMMIT'); return discussion;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  ensureCompanion(book: BookSummary, directory: string): ReadingDiscussion {
    const sessionId = `reading-${book.version}`;
    const existing = this.discussion(sessionId); if (existing) return existing;
    const discussion: ReadingDiscussion = { sessionId, bookId: book.id, title: `书伴 · ${book.title}`.slice(0, 80), parentSessionId: null, reference: null, createdAt: new Date().toISOString() };
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO reading_discussion VALUES (?,?,?)').run(sessionId, book.id, JSON.stringify(discussion));
      this.database.prepare(`INSERT INTO assistant_session_registry (session_id,title,kind,workspace_id,created_at,archived_at,parent_session_id,origin_json,working_directory_kind,working_directory_path) VALUES (?,?,'work','default',?,NULL,NULL,NULL,'session-temp',?)`).run(sessionId, discussion.title, discussion.createdAt, directory);
      this.database.exec('COMMIT'); return discussion;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  get(id: string): Book | null {
    const row = this.database.prepare('SELECT 1 FROM reading_book WHERE book_id=?').get(id);
    if (!row) return null;
    return this.content.full(id);
  }
  list(): BookSummary[] {
    return this.database.prepare("SELECT json_remove(record_json, '$.chapters') AS record_json FROM reading_book ORDER BY rowid DESC").all().map(row => JSON.parse(String(row.record_json)));
  }
  importIndexed(index: BookIndex, commandId: string, fingerprint: string, blocks: Iterable<Book['chapters']>): { book: BookSummary; changed: boolean } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.database.prepare('SELECT fingerprint,book_id FROM reading_command WHERE command_id=?').get(commandId);
      if (receipt && receipt.fingerprint !== fingerprint) throw new ReadingError('同一命令不能导入不同内容。', 409);
      const id = receipt ? String(receipt.book_id) : index.id;
      const exists = this.database.prepare('SELECT 1 FROM reading_book WHERE book_id=?').get(id);
      if (!exists) {
        if (this.list().length >= 200) throw new ReadingError('书架最多保存 200 本书。', 409);
        const { chapters: _chapters, blockCount: _count, ...summary } = index;
        this.database.prepare('INSERT INTO reading_book VALUES (?,?)').run(id, JSON.stringify(summary));
        let ordinal = 0;
        for (const block of blocks) this.content.putBlock(id, ordinal++, block);
        if (ordinal !== index.blockCount) throw new Error('正文块数量与索引不一致。');
        this.content.putIndex(index);
      }
      this.database.prepare('INSERT OR IGNORE INTO reading_command VALUES (?,?,?)').run(commandId, fingerprint, id);
      const summary = this.content.summary(id);
      this.database.exec('COMMIT'); return { book: summary, changed: !exists };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  annotations(bookId: string): ReadingAnnotation[] {
    return this.database.prepare('SELECT record_json FROM reading_annotation WHERE book_id=? ORDER BY rowid').all(bookId).map(row => {
      const value: unknown = JSON.parse(String(row.record_json));
      if (!Check(ReadingAnnotationSchema, value)) throw new Error('阅读记录存储契约无效。');
      return value;
    });
  }
  annotationReceipt(commandId: string, fingerprint: string): { record: ReadingAnnotation | null } | null {
    const row = this.database.prepare('SELECT fingerprint,result_json FROM reading_annotation_command WHERE command_id=?').get(commandId) as { fingerprint: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new ReadingError('命令参数冲突。', 409);
    return JSON.parse(row.result_json);
  }
  annotate(bookId: string, input: AnnotationCommand, fingerprint: string): { record: ReadingAnnotation | null; changed: boolean } {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.database.prepare('SELECT fingerprint,result_json FROM reading_annotation_command WHERE command_id=?').get(input.commandId) as { fingerprint: string; result_json: string } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ReadingError('命令参数冲突。', 409);
        this.database.exec('COMMIT'); return { record: JSON.parse(receipt.result_json).record, changed: false };
      }
      const row = this.database.prepare('SELECT book_id,record_json FROM reading_annotation WHERE id=?').get(input.id) as { book_id: string; record_json: string } | undefined;
      const existing = row ? JSON.parse(row.record_json) as ReadingAnnotation : null;
      if (row && row.book_id !== bookId || (existing?.revision ?? 0) !== input.expectedRevision || existing && existing.kind !== input.kind) throw new ReadingError('记录已被其他窗口修改，请重新读取。', 409);
      let record: ReadingAnnotation | null = null;
      if (input.action === 'save') {
        if (!existing && this.annotations(bookId).length >= 2000) throw new ReadingError('每本书最多保存 2000 条标注。', 409);
        record = { id: input.id, bookId, kind: input.kind, revision: input.expectedRevision + 1, reference: input.reference ?? existing!.reference, remark: input.remark ?? existing?.remark ?? '', updatedAt: new Date().toISOString() };
        this.database.prepare('INSERT INTO reading_annotation VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, bookId, JSON.stringify(record));
      } else {
        if (!existing) throw new ReadingError('记录已删除。', 404);
        this.database.prepare('DELETE FROM reading_annotation WHERE id=?').run(input.id);
      }
      this.database.prepare('INSERT INTO reading_annotation_command VALUES (?,?,?)').run(input.commandId, fingerprint, JSON.stringify({ record }));
      this.database.exec('COMMIT'); return { record, changed: true };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  import(book: Book, commandId: string, fingerprint: string): Book {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.database.prepare('SELECT fingerprint,book_id FROM reading_command WHERE command_id=?').get(commandId) as { fingerprint: string; book_id: string } | undefined;
      if (receipt && receipt.fingerprint !== fingerprint) throw new ReadingError('同一命令不能导入不同内容。', 409);
      const existing = this.get(receipt?.book_id ?? book.id);
      if (!existing && this.list().length >= 200) throw new ReadingError('书架最多保存 200 本书。', 409);
      if (!existing) this.database.prepare('INSERT INTO reading_book VALUES (?,?)').run(book.id, JSON.stringify(book));
      this.database.prepare('INSERT OR IGNORE INTO reading_command VALUES (?,?,?)').run(commandId, fingerprint, book.id);
      this.database.exec('COMMIT');
      return existing ?? book;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
