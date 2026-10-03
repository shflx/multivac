import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImportBook } from '@multivac/contracts';
import { parseBook, readingHash, ReadingError } from '../modules/reading/book-import.js';
import type { SqliteReadingRepository } from '../storage/sqlite-reading-repository.js';

export class ReadingService {
  constructor(private readonly repository: SqliteReadingRepository, private readonly sourceDir: string) {}
  list() { return this.repository.list(); }
  get(id: string) {
    const book = this.repository.get(id);
    if (!book) throw new ReadingError('书籍不存在或已删除。', 404);
    return book;
  }
  async import(input: ImportBook) {
    const book = parseBook(input);
    await mkdir(this.sourceDir, { recursive: true, mode: 0o700 });
    // 文件名仅由服务端正文签名派生；不可变来源先落盘，SQLite 再发布书籍与回执。
    try { await writeFile(join(this.sourceDir, `${book.version}.${book.format}`), input.text, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return this.repository.import(book, input.commandId, readingHash(JSON.stringify([input.title, input.author, input.format, input.text])));
  }
}
