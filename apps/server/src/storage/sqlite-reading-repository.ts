import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { BookSchema, ReadingAnnotationSchema, type Book, type BookSummary, type ReadingAnnotation, type AnnotationCommand } from '@multivac/contracts';
import { ReadingError } from '../modules/reading/book-import.js';

export const READING_MIGRATION = `
  CREATE TABLE reading_book (book_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE reading_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES reading_book(book_id)) STRICT;
`;
export const READING_ANNOTATION_MIGRATION = `
  CREATE TABLE reading_annotation (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE INDEX reading_annotation_book ON reading_annotation(book_id);
  CREATE TABLE reading_annotation_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export class SqliteReadingRepository {
  constructor(private readonly database: DatabaseSync) {}
  get(id: string): Book | null {
    const row = this.database.prepare('SELECT record_json FROM reading_book WHERE book_id=?').get(id) as { record_json: string } | undefined;
    if (!row) return null;
    const value: unknown = JSON.parse(row.record_json);
    if (!Check(BookSchema, value)) throw new Error('书籍存储契约无效。');
    return value;
  }
  list(): BookSummary[] {
    return this.database.prepare('SELECT book_id FROM reading_book ORDER BY rowid DESC').all().map(row => {
      const { chapters: _chapters, ...summary } = this.get(String(row.book_id))!; return summary;
    });
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
