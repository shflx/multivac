import { positionRank as loadedRank, validBookReference as loadedReference, type Book, type BookIndex, type BookPosition, type BookReference, type BookLocation } from '@multivac/contracts';

export type ReadingBook = Book & { index?: BookIndex; block?: number };
const positions = new WeakMap<BookIndex, Map<string, BookIndex['chapters'][number]['paragraphs'][number]>>();
export function indexedPosition(index: BookIndex, position: BookPosition) {
  let map = positions.get(index);
  if (!map) {
    map = new Map(index.chapters.flatMap(chapter => chapter.paragraphs.map(p => [`${chapter.id}/${p.id}`, p] as const)));
    positions.set(index, map);
  }
  return map.get(`${position.chapterId}/${position.paragraphId}`);
}
export function positionRank(book: ReadingBook, position: BookPosition) {
  if (!book.index) return loadedRank(book, position);
  const entry = indexedPosition(book.index, position);
  if (!entry || !Number.isInteger(position.offset) || position.offset < 0 || position.offset > entry.length) return -1;
  if (entry.block === book.block && loadedRank(book, position) < 0) return -1;
  return entry.rank + position.offset;
}
/** 客户端只判断出处能否定位；服务端仍从真实正文逐字核对，不信任索引或客户端摘录。 */
export function validBookReference(book: ReadingBook, reference: BookReference) {
  if (!book.index) return loadedReference(book, reference);
  if (book.id !== reference.bookId || book.version !== reference.version) return false;
  const a = positionRank(book, reference.start), b = positionRank(book, reference.end);
  if (a < 0 || b <= a || b - a !== reference.text.length) return false;
  if (indexedPosition(book.index, reference.start)?.block === book.block && indexedPosition(book.index, reference.end)?.block === book.block) return loadedReference(book, reference);
  return true;
}
export function validBookLocation(book: ReadingBook, location: BookLocation): boolean {
  return location.bookId === book.id && location.version === book.version && positionRank(book, location.position) >= 0;
}
export function blockPosition(index: BookIndex, block: number, end = false): BookPosition | null {
  const entries = index.chapters.flatMap(chapter => chapter.paragraphs.filter(p => p.block === block).map(p => ({ chapterId: chapter.id, paragraphId: p.id, offset: end ? p.length : 0 })));
  return (end ? entries.at(-1) : entries[0]) ?? null;
}
