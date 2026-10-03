import { bookParagraphs } from './reading-state.js';

/** 测量函数与正文使用相同的宽度、字体和间距；分页结果只保存文本偏移。 */
export function paginateBook(book, { height, measure, gap = 0 }) {
  if (!(height > 0)) return [];
  const pages = [];
  let page = null;
  let used = 0;
  const position = (paragraph, offset) => ({ bookId: book.id, chapterId: paragraph.chapterId, paragraphId: paragraph.paragraphId, offset });
  const begin = (paragraph, offset) => {
    page = { chapterId: paragraph.chapterId, chapterTitle: paragraph.chapterTitle, fragments: [], start: position(paragraph, offset), end: position(paragraph, offset) };
    pages.push(page);
    used = 0;
  };
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  for (const paragraph of bookParagraphs(book)) {
    if (!paragraph.text) continue;
    const boundaries = [...segmenter.segment(paragraph.text)].map((segment) => segment.index);
    boundaries.push(paragraph.text.length);
    let offset = 0;
    let boundaryIndex = 0;
    while (offset < paragraph.text.length) {
      if (!page || page.chapterId !== paragraph.chapterId) begin(paragraph, offset);
      const spacing = page.fragments.length ? gap : 0;
      const remaining = height - used - spacing;
      let low = boundaryIndex + 1;
      let high = boundaries.length - 1;
      let fit = boundaryIndex;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (measure(paragraph.text.slice(offset, boundaries[middle])) <= remaining) { fit = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (fit === boundaryIndex) {
        if (page.fragments.length) { begin(paragraph, offset); continue; }
        // 极小视口仍完整显示至少一个字形，UI 会给正文保留一行的最小高度。
        fit = boundaryIndex + 1;
      }
      const end = boundaries[fit];
      const text = paragraph.text.slice(offset, end);
      page.fragments.push({ chapterId: paragraph.chapterId, paragraphId: paragraph.paragraphId, start: offset, end, text });
      page.end = position(paragraph, end);
      used += measure(text) + spacing;
      offset = end;
      boundaryIndex = fit;
      if (offset < paragraph.text.length) begin(paragraph, offset);
    }
  }
  return pages.filter((item) => item.fragments.length);
}

export function createDOMMeasurer(width, fontSize) {
  const container = document.createElement('div');
  container.className = 'reading-measure reading-prose';
  Object.assign(container.style, { width: `${width}px`, fontSize: `${fontSize}px` });
  const paragraph = document.createElement('p');
  container.append(paragraph);
  document.body.append(container);
  return {
    gap: fontSize * 0.8,
    measure: (text) => {
      paragraph.textContent = text;
      return paragraph.getBoundingClientRect().height;
    },
    dispose: () => container.remove(),
  };
}

/** 选区端点转换为正文偏移；不把 Range、节点或屏幕坐标存进阅读状态。 */
export function captureReadingSelection(book, article) {
  if (!article) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
  const endpoint = (container, offset, end) => {
    const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    let fragment = element.closest?.('[data-reading-fragment]');
    if (!fragment) {
      let paragraph = element.closest?.('p');
      if (!paragraph) {
        const child = element.childNodes?.[end ? offset - 1 : offset];
        paragraph = child?.nodeType === Node.ELEMENT_NODE ? child.closest('p') || child.querySelector('p') : null;
      }
      fragment = paragraph?.querySelector('[data-reading-fragment]');
      if (!fragment) return null;
      return { bookId: book.id, chapterId: fragment.dataset.chapter, paragraphId: fragment.dataset.paragraphId, offset: Number(fragment.dataset.start) + (end ? fragment.textContent.length : 0) };
    }
    const prefix = document.createRange();
    prefix.selectNodeContents(fragment);
    try { prefix.setEnd(container, offset); } catch { return null; }
    return { bookId: book.id, chapterId: fragment.dataset.chapter, paragraphId: fragment.dataset.paragraphId, offset: Number(fragment.dataset.start) + prefix.toString().length };
  };
  const start = endpoint(range.startContainer, range.startOffset, false);
  const end = endpoint(range.endContainer, range.endOffset, true);
  return start && end ? { start, end } : null;
}

export function canTurnReadingPage(event) {
  return !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.target?.closest?.('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"], [role="button"]');
}
