import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { BookSchema, type Book, type BookSummary } from '@multivac/contracts';
import { ReadingError } from '../modules/reading/book-import.js';

export const READING_MIGRATION = `
  CREATE TABLE reading_book (book_id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE reading_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, book_id TEXT NOT NULL REFERENCES reading_book(book_id)) STRICT;
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
