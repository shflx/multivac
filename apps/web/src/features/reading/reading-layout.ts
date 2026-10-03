import { positionRank, referenceText, type Book, type BookPosition, type BookReference } from '@multivac/contracts';

export interface ReadingPage { start: BookPosition; end: BookPosition; reference: BookReference }
export function pageForPosition(book: Book, pages: ReadingPage[], position: BookPosition): number {
  const rank = positionRank(book, position);
  let index = 0;
  pages.forEach((page, i) => { if (positionRank(book, page.start) <= rank) index = i; });
  return index;
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
    const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-paragraph]');
    if (!element) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(element); prefix.setEnd(node, offset);
    return { chapterId: element.dataset.chapter!, paragraphId: element.dataset.paragraph!, offset: prefix.toString().length };
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
  const left = flow.getBoundingClientRect().left;
  const pageOf = (element: HTMLElement, offset: number) => {
    const range = document.createRange();
    const [node, n] = textEndpoint(element, offset); range.setStart(node, n);
    const next = textEndpoint(element, Math.min(offset + (/[\uD800-\uDBFF]/u.test(element.textContent?.[offset] ?? '') ? 2 : 1), element.textContent?.length ?? 0));
    range.setEnd(...next);
    const rect = range.getClientRects()[0] ?? element.getBoundingClientRect();
    return Math.max(0, Math.floor((rect.left - left + .5) / width));
  };
  const ranges = new Map<number, { start: BookPosition; end: BookPosition }>();
  for (const element of flow.querySelectorAll<HTMLElement>('[data-paragraph]')) {
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
      const position = (offset: number): BookPosition => ({ chapterId: element.dataset.chapter!, paragraphId: element.dataset.paragraph!, offset });
      const existing = ranges.get(page);
      ranges.set(page, { start: existing?.start ?? position(boundaries[begin]!), end: position(boundaries[end]!) });
      begin = end;
    }
  }
  return [...ranges.entries()].sort((a, b) => a[0] - b[0]).map(([, range]) => ({ ...range, reference: { bookId: book.id, version: book.version, ...range, text: referenceText(book, range.start, range.end) } }));
}
