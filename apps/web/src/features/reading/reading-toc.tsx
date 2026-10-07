import type { BookPosition, BookTocEntry } from '@multivac/contracts';
import { positionRank, type ReadingBook } from './reading-book.js';

export function ReadingToc({ book, position, locate }: { book: ReadingBook; position: BookPosition; locate: (position: BookPosition) => void }) {
  const source = book.index ?? book;
  const entries: BookTocEntry[] = source.toc?.length ? source.toc : source.chapters.filter(chapter => chapter.paragraphs.length).map(chapter => ({
    id: chapter.id, title: chapter.title, depth: 0, position: { chapterId: chapter.id, paragraphId: chapter.paragraphs[0]!.id, offset: 0 },
  }));
  const currentRank = positionRank(book, position);
  let active = -1, activeRank = -1;
  for (const [index, entry] of entries.entries()) {
    const rank = entry.position ? positionRank(book, entry.position) : -1;
    if (rank >= 0 && rank <= currentRank && rank >= activeRank) { active = index; activeRank = rank; }
  }
  return <>{entries.map((entry, index) => <button key={entry.id} aria-label={entry.title}
    aria-current={index === active ? 'location' : undefined} disabled={!entry.position}
    title={entry.position ? undefined : '此目录项没有可读取的正文位置'}
    style={{ paddingInlineStart: 8 + Math.min(entry.depth, 8) * 16 }}
    onClick={() => { if (entry.position) locate(entry.position); }}><span>{entry.title}</span></button>)}</>;
}
