import { BOOK_CONTENT_BLOCK_LENGTH, type Book, type BookIndex, type BookSummary, type BookTocEntry } from '@multivac/contracts';
import { ReadingError } from './book-import.js';

/** 索引只保存位置和长度；正文块按段落边界切分，不改变章节、段落或 UTF-16 引用。 */
export class BookIndexer {
  private chapters: BookIndex['chapters'] = [];
  private block: Book['chapters'] = [];
  private blockLength = 0;
  private ordinal = 0;
  private blockParagraphs = 0;
  private rank = 0;
  private count = 0;
  constructor(private readonly write: (ordinal: number, chapters: Book['chapters']) => void) {}
  add(chapter: Book['chapters'][number]) {
    if (this.chapters.length >= 10000) throw new ReadingError('书籍目录超过 10000 项。', 413);
    const entry: BookIndex['chapters'][number] = { id: chapter.id, title: chapter.title, paragraphs: [] };
    this.chapters.push(entry);
    for (const paragraph of chapter.paragraphs) {
      if (++this.count > 100000) throw new ReadingError('书籍超过 100000 段。', 413);
      if (this.blockLength && (this.blockLength + paragraph.text.length + 1 > BOOK_CONTENT_BLOCK_LENGTH || this.blockParagraphs >= 128)) this.flush();
      entry.paragraphs.push({ id: paragraph.id, length: paragraph.text.length, rank: this.rank, block: this.ordinal });
      this.rank += paragraph.text.length + 1;
      let current = this.block.at(-1);
      if (current?.id !== chapter.id) { current = { id: chapter.id, title: chapter.title, paragraphs: [] }; this.block.push(current); }
      current.paragraphs.push(paragraph);
      this.blockLength += paragraph.text.length + 1; ++this.blockParagraphs;
    }
  }
  finish(summary: Omit<BookSummary, 'paragraphCount'>, toc?: BookTocEntry[]): BookIndex {
    this.flush();
    if (!this.count) throw new ReadingError('书籍没有可读正文。');
    return { ...summary, paragraphCount: this.count, blockCount: this.ordinal, chapters: this.chapters, ...(toc ? { toc } : {}) };
  }
  private flush() {
    if (!this.blockLength) return;
    this.write(this.ordinal++, this.block);
    this.block = []; this.blockLength = 0; this.blockParagraphs = 0;
  }
}
