import { positionRank } from './reading-book.js';
import type { ReadingBook } from './reading-book.js';
import { referenceText, type Book, type BookPosition, type BookReference } from '@multivac/contracts';

export interface ReadingImageFrame {
  id: string; chapterId: string; paragraphId: string;
  left: number; top: number; width: number; height: number;
}
export interface ReadingPage {
  start: BookPosition; end: BookPosition; reference: BookReference; column: number;
  imageIds?: string[]; imageOnly: boolean; imageFrames: ReadingImageFrame[];
}
export function createPositionRanker(book: ReadingBook) {
  if (book.index) return (position: BookPosition) => positionRank(book, position);
  const starts = new Map<string, number>(); let rank = 0;
  for (const c of book.chapters) for (const p of c.paragraphs) { starts.set(`${c.id}/${p.id}`, rank); rank += p.text.length + 1; }
  return (position: BookPosition) => { const base = starts.get(`${position.chapterId}/${position.paragraphId}`); return base === undefined ? -1 : base + position.offset; };
}
export function pageForPosition(book: Book, pages: ReadingPage[], position: BookPosition, ranker = createPositionRanker(book)): number {
  const rank = ranker(position);
  let low = 0, high = pages.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (ranker(pages[middle]!.start) <= rank) low = middle; else high = middle - 1; }
  return low;
}
export function textEndpoint(element: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode(); let remaining = offset;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return [node, remaining];
    remaining -= length; node = walker.nextNode();
  }
  return [element, element.childNodes.length];
}

export function captureBookSelection(book: Book, flow: HTMLElement): { reference: BookReference; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!flow.contains(range.startContainer) || !flow.contains(range.endContainer)) return null;
  const endpoint = (node: Node, offset: number): BookPosition | null => {
    const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-reading-text]');
    if (!element) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset);
    return { chapterId: element.dataset.chapter!, paragraphId: element.dataset.paragraph!, offset: Number(element.dataset.offset ?? 0) + prefix.toString().length };
  };
  const start = endpoint(range.startContainer, range.startOffset), end = endpoint(range.endContainer, range.endOffset);
  if (!start || !end) return null;
  const text = referenceText(book, start, end);
  if (!text || text.length > 65536) return null;
  return { reference: { bookId: book.id, version: book.version, start, end, text }, rect: range.getBoundingClientRect() };
}

/** 浏览器原生多栏完成换行、字形与段落断页；这里只读取栏边界并还原稳定原文位置。 */
export function measureReadingPages(book: Book, flow: HTMLElement, width: number): ReadingPage[] {
  if (width <= 0 || flow.getBoundingClientRect().height <= 0) return [];
  const flowRect = flow.getBoundingClientRect();
  const left = flowRect.left;
  const pageOf = (element: HTMLElement, offset: number) => {
    const range = document.createRange();
    const [node, n] = textEndpoint(element, offset); range.setStart(node, n);
    const next = textEndpoint(element, Math.min(offset + (/[\uD800-\uDBFF]/u.test(element.textContent?.[offset] ?? '') ? 2 : 1), element.textContent?.length ?? 0));
    range.setEnd(...next);
    const rect = range.getClientRects()[0] ?? element.getBoundingClientRect();
    return Math.max(0, Math.floor((rect.left - left + .5) / width));
  };
  const ranges = new Map<number, { start: BookPosition; end: BookPosition; imageIds?: string[]; hasText?: boolean; imageFrames?: ReadingImageFrame[] }>();
  for (const element of flow.querySelectorAll<HTMLElement>('[data-reading-text], [data-reading-image]')) {
    const base = Number(element.dataset.offset ?? 0);
    const position = (offset: number): BookPosition => ({ chapterId: element.dataset.chapter!, paragraphId: element.dataset.paragraph!, offset: base + offset });
    if (element.dataset.readingImage) {
      const rect = element.getBoundingClientRect();
      const page = Math.max(0, Math.floor((rect.left - left + .5) / width));
      const existing = ranges.get(page);
      const frame: ReadingImageFrame = {
        id: element.dataset.readingImage, chapterId: element.dataset.chapter!, paragraphId: element.dataset.paragraph!,
        left: rect.left - left - page * width, top: rect.top - flowRect.top, width: rect.width, height: rect.height,
      };
      ranges.set(page, { ...existing, start: existing?.start ?? position(0), end: position(0), imageIds: [...(existing?.imageIds ?? []), frame.id], imageFrames: [...(existing?.imageFrames ?? []), frame] });
      continue;
    }
    const text = element.textContent ?? '';
    const boundaries = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map(s => s.index);
    boundaries.push(text.length);
    let begin = 0;
    while (begin < boundaries.length - 1) {
      const page = pageOf(element, boundaries[begin]!);
      let low = begin + 1, high = boundaries.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (pageOf(element, boundaries[middle]!) > page) high = middle; else low = middle + 1;
      }
      const end = low;
      const existing = ranges.get(page);
      // 按实际落在本栏的文字判断；整段有文字不代表每一页都是图文混排。
      const hasText = Boolean(existing?.hasText || text.slice(boundaries[begin]!, boundaries[end]!).trim());
      ranges.set(page, { ...existing, hasText, start: existing?.start ?? position(boundaries[begin]!), end: position(boundaries[end]!) });
      begin = end;
    }
  }
  return [...ranges.entries()].sort((a, b) => a[0] - b[0]).map(([column, { hasText, imageFrames = [], ...range }]) => ({
    ...range, column, imageOnly: Boolean(range.imageIds?.length && !hasText), imageFrames,
    // 页面类型和显示几何仅用于前端，不能混入服务端逐字核对的原文引用。
    reference: { bookId: book.id, version: book.version, ...range, text: referenceText(book, range.start, range.end, range.imageIds) },
  }));
}
