import type { DatabaseSync } from 'node:sqlite';
import { BookSchema, validBookReference, positionRank, type Book, type BookIndex, type BookPosition, type BookReference, type BookSummary } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { BookIndexer } from '../modules/reading/book-index.js';
import { ReadingError } from '../modules/reading/book-import.js';

export const READING_CONTENT_MIGRATION = `
  CREATE TABLE reading_book_index (book_id TEXT PRIMARY KEY REFERENCES reading_book(book_id), record_json TEXT NOT NULL) STRICT;
  CREATE TABLE reading_book_block (book_id TEXT NOT NULL REFERENCES reading_book(book_id), ordinal INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(book_id, ordinal)) STRICT;
`;
export class SqliteBookContent {
  constructor(private readonly database: DatabaseSync) {}
  index(id: string): BookIndex {
    const row = this.database.prepare('SELECT record_json FROM reading_book_index WHERE book_id=?').get(id);
    if (row) return JSON.parse(String(row.record_json));
    const old = this.database.prepare('SELECT record_json FROM reading_book WHERE book_id=?').get(id);
    if (!old) throw new ReadingError('书籍不存在或已删除。', 404);
    const book: unknown = JSON.parse(String(old.record_json));
    if (!Check(BookSchema, book)) throw new Error('书籍存储契约无效。');
    // 老书首次访问时原位迁移；SAVEPOINT 也允许在笔记校验事务中调用。
    this.database.exec('SAVEPOINT reading_content');
    try {
      const builder = new BookIndexer((ordinal, chapters) => this.putBlock(id, ordinal, chapters));
      for (const chapter of book.chapters) builder.add(chapter);
      const { chapters: _chapters, ...summary } = book;
      const index = builder.finish(summary);
      this.putIndex(index);
      this.database.exec('RELEASE reading_content');
      return index;
    } catch (error) { this.database.exec('ROLLBACK TO reading_content; RELEASE reading_content'); throw error; }
  }
  putBlock(id: string, ordinal: number, chapters: Book['chapters']) {
    this.database.prepare('INSERT INTO reading_book_block VALUES (?,?,?)').run(id, ordinal, JSON.stringify(chapters));
  }
  putIndex(index: BookIndex) {
    const { chapters: _chapters, blockCount: _count, ...summary } = index;
    this.database.prepare('INSERT INTO reading_book_index VALUES (?,?)').run(index.id, JSON.stringify(index));
    this.database.prepare('UPDATE reading_book SET record_json=? WHERE book_id=?').run(JSON.stringify(summary), index.id);
  }
  summary(id: string): BookSummary {
    const row = this.database.prepare("SELECT json_remove(record_json, '$.chapters') AS record_json FROM reading_book WHERE book_id=?").get(id);
    if (!row) throw new ReadingError('书籍不存在或已删除。', 404);
    return JSON.parse(String(row.record_json));
  }
  block(id: string, ordinal: number): Book {
    const summary = this.summary(id);
    const statement = this.database.prepare('SELECT record_json FROM reading_book_block WHERE book_id=? AND ordinal=?');
    let row = statement.get(id, ordinal);
    if (!row) { this.index(id); row = statement.get(id, ordinal); }
    if (!row) throw new ReadingError('正文位置不存在。', 404);
    return { ...summary, chapters: JSON.parse(String(row.record_json)) };
  }
  full(id: string): Book {
    const index = this.index(id);
    const chapters = index.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, paragraphs: [] as Book['chapters'][number]['paragraphs'] }));
    const byId = new Map(chapters.map(chapter => [chapter.id, chapter]));
    for (const row of this.database.prepare('SELECT record_json FROM reading_book_block WHERE book_id=? ORDER BY ordinal').iterate(id)) {
      for (const chapter of JSON.parse(String(row.record_json)) as Book['chapters']) byId.get(chapter.id)!.paragraphs.push(...chapter.paragraphs);
    }
    return { ...this.summary(id), chapters };
  }
  position(id: string, position: BookPosition) {
    const entry = this.index(id).chapters.find(c => c.id === position.chapterId)?.paragraphs.find(p => p.id === position.paragraphId);
    if (!entry || position.offset < 0 || position.offset > entry.length) return null;
    if (positionRank(this.block(id, entry.block), position) < 0) return null;
    return { ...entry, rank: entry.rank + position.offset };
  }
  validReference(id: string, reference: BookReference): boolean {
    if (reference.bookId !== id || reference.version !== this.index(id).version) return false;
    const start = this.position(id, reference.start), end = this.position(id, reference.end);
    if (!start || !end || end.rank - start.rank !== reference.text.length || reference.text.length > 65536) return false;
    const chapters: Book['chapters'] = [];
    for (let ordinal = start.block; ordinal <= end.block; ordinal++) {
      for (const chapter of this.block(id, ordinal).chapters) {
        const previous = chapters.at(-1);
        if (previous?.id === chapter.id) previous.paragraphs.push(...chapter.paragraphs); else chapters.push(chapter);
      }
    }
    return validBookReference({ ...this.summary(id), chapters }, reference);
  }
  readTail(id: string, boundary: BookPosition | null) {
    if (!boundary) return { excerpt: '', truncated: false };
    const end = this.position(id, boundary);
    if (!end) throw new ReadingError('已读位置失效。', 409);
    let text = '', ordinal = end.block;
    while (ordinal >= 0 && text.length <= 32002) {
      const paragraphs = this.block(id, ordinal).chapters.flatMap(chapter => chapter.paragraphs.map(p => ({ ...p, chapterId: chapter.id })));
      if (ordinal === end.block) {
        const last = paragraphs.findIndex(p => p.id === boundary.paragraphId && p.chapterId === boundary.chapterId);
        paragraphs.splice(last + 1); paragraphs[last]!.text = paragraphs[last]!.text.slice(0, boundary.offset);
      }
      text = paragraphs.map(p => p.text).join('\n') + (text ? '\n' + text : ''); --ordinal;
    }
    const characters = [...text];
    return { excerpt: characters.slice(-16000).join(''), truncated: ordinal >= 0 || characters.length > 16000 };
  }
}
