import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validBookReference, bookParagraphs, positionRank, referenceText, type ImportBook, type AnnotationCommand, type ReadingScopeCommand, type BookReference, type CoordinatorSessionContext } from '@multivac/contracts';
import { parseBook, readingHash, ReadingError } from '../modules/reading/book-import.js';
import type { SqliteReadingRepository } from '../storage/sqlite-reading-repository.js';
import type { WorkbenchEventPublisher } from './workbench-events.js';

export class ReadingService {
  constructor(private readonly repository: SqliteReadingRepository, private readonly sourceDir: string, private readonly events?: WorkbenchEventPublisher, private readonly sessionsDir?: string) {}
  discussion(sessionId: string) { return this.repository.discussion(sessionId); }
  scope(bookId: string) { return this.repository.scope(this.get(bookId)); }
  setScope(bookId: string, command: ReadingScopeCommand) {
    const book = this.get(bookId);
    if (command.boundary && positionRank(book, command.boundary) < 0) throw new ReadingError('已读边界原文位置无效。');
    const result = this.repository.setScope(book, command, readingHash(JSON.stringify([bookId, command])));
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId });
    return result.scope;
  }
  ensureCompanion(bookId: string) {
    const book = this.get(bookId);
    if (!this.sessionsDir) throw new ReadingError('书伴会话目录不可用。', 503);
    const existed = this.repository.discussion(`reading-${book.version}`);
    const discussion = this.repository.ensureCompanion(book, join(this.sessionsDir, `reading-${book.version}`));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId });
    return discussion;
  }
  context(sessionId: string, reference: BookReference): CoordinatorSessionContext {
    const discussion = this.discussion(sessionId);
    if (!discussion || discussion.bookId !== reference.bookId) throw new ReadingError('书籍引用不属于当前书伴。');
    const book = this.get(reference.bookId);
    if (!validBookReference(book, reference) || reference.text.length > 16000) throw new ReadingError('书籍引用无效或超过 16000 字符，请缩短选区。');
    const scope = this.scope(book.id);
    const first = bookParagraphs(book)[0]!;
    const read = scope.boundary ? referenceText(book, { chapterId: first.chapterId, paragraphId: first.id, offset: 0 }, scope.boundary) : '';
    const characters = [...read];
    return { kind: 'reading', title: book.title, reference, boundary: scope.boundary, excerpt: characters.slice(-16000).join(''), truncated: characters.length > 16000 };
  }
  list() { return this.repository.list(); }
  get(id: string) {
    const book = this.repository.get(id);
    if (!book) throw new ReadingError('书籍不存在或已删除。', 404);
    return book;
  }
  annotations(id: string) { return this.repository.annotations(id); }
  annotate(id: string, input: AnnotationCommand) {
    const fingerprint = readingHash(JSON.stringify([id, input]));
    const receipt = this.repository.annotationReceipt(input.commandId, fingerprint);
    if (receipt) return receipt;
    if (input.action === 'save') {
      const previous = this.repository.annotations(id).find(record => record.id === input.id);
      const reference = input.reference ?? previous?.reference;
      if (!reference || !validBookReference(this.get(id), reference)) throw new ReadingError('原文引用版本或位置已失效，摘录仍可查看。', 409);
    }
    const result = this.repository.annotate(id, input, fingerprint);
    if (result.changed) this.events?.publish({ type: 'reading.changed', bookId: id });
    return { record: result.record };
  }
  async import(input: ImportBook) {
    const book = parseBook(input);
    await mkdir(this.sourceDir, { recursive: true, mode: 0o700 });
    // 文件名仅由服务端正文签名派生；不可变来源先落盘，SQLite 再发布书籍与回执。
    try { await writeFile(join(this.sourceDir, `${book.version}.${book.format}`), input.text, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const existed = this.repository.get(book.id);
    const saved = this.repository.import(book, input.commandId, readingHash(JSON.stringify([input.title, input.author, input.format, input.text])));
    if (!existed) this.events?.publish({ type: 'reading.changed', bookId: book.id });
    return saved;
  }
}
