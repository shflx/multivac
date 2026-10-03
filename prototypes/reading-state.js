import { normalizeReadingView } from './reading-view-state.js';

export const READING_STORAGE_KEY = 'multivac.prototype.reading.v1';
export const readingId = () => crypto.randomUUID();

export function bookParagraphs(book) {
  return book.chapters.flatMap((chapter, chapterIndex) => chapter.paragraphs.map((paragraph, paragraphIndex) => ({
    chapterId: chapter.id, chapterTitle: chapter.title, chapterIndex, paragraphIndex,
    paragraphId: typeof paragraph === 'string' ? `${chapter.id}:p${paragraphIndex + 1}` : paragraph.id,
    text: typeof paragraph === 'string' ? paragraph : paragraph.text,
  })));
}

export function bookSignature(book) {
  let hash = 2166136261;
  const text = bookParagraphs(book).map((paragraph) => `${paragraph.paragraphId}:${paragraph.text}`).join('\n');
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return String(hash >>> 0);
}

export function firstPosition(book) {
  const paragraph = bookParagraphs(book)[0];
  return { bookId: book.id, chapterId: paragraph.chapterId, paragraphId: paragraph.paragraphId, offset: 0 };
}

export function validPosition(book, position) {
  if (!position || position.bookId !== book.id || !Number.isInteger(position.offset)) return false;
  const paragraph = bookParagraphs(book).find((item) => item.chapterId === position.chapterId && item.paragraphId === position.paragraphId);
  return Boolean(paragraph && position.offset >= 0 && position.offset <= paragraph.text.length);
}

export function positionRank(book, position) {
  if (!validPosition(book, position)) return -1;
  let offset = 0;
  for (const paragraph of bookParagraphs(book)) {
    if (paragraph.paragraphId === position.paragraphId && paragraph.chapterId === position.chapterId) return offset + position.offset;
    offset += paragraph.text.length + 1;
  }
  return -1;
}

export function referenceText(book, reference) {
  if (!reference || !validPosition(book, reference.start) || !validPosition(book, reference.end)) return '';
  if (positionRank(book, reference.start) > positionRank(book, reference.end)) return '';
  const paragraphs = bookParagraphs(book);
  const start = paragraphs.findIndex((item) => item.paragraphId === reference.start.paragraphId && item.chapterId === reference.start.chapterId);
  const end = paragraphs.findIndex((item) => item.paragraphId === reference.end.paragraphId && item.chapterId === reference.end.chapterId);
  return paragraphs.slice(start, end + 1).map((paragraph, index, slice) => paragraph.text.slice(index === 0 ? reference.start.offset : 0, index === slice.length - 1 ? reference.end.offset : paragraph.text.length)).join('\n');
}

export function validReference(book, reference) {
  if (reference?.unavailable) return false;
  const text = referenceText(book, reference);
  return Boolean(text && (!reference.text || reference.text === text));
}

export function makeReference(book, start, end, pageNumber) {
  const reference = { start: { ...start }, end: { ...end }, pageNumber, chapterTitle: book.chapters.find((chapter) => chapter.id === start.chapterId)?.title || '' };
  return { ...reference, text: referenceText(book, reference) };
}

export const positionKey = (position) => `${position.bookId}/${position.chapterId}/${position.paragraphId}/${position.offset}`;

/** 只按稳定位置去重；不会把重复文字合并为同一处。 */
export function toggleBookmark(book, bookmarks, reference, at = new Date().toISOString()) {
  if (!validReference(book, reference)) return bookmarks;
  const key = positionKey(reference.start);
  if (bookmarks.some((bookmark) => validReference(book, bookmark.reference) && positionKey(bookmark.reference.start) === key)) return bookmarks.filter((bookmark) => !validReference(book, bookmark.reference) || positionKey(bookmark.reference.start) !== key);
  return [...bookmarks, { id: readingId(), reference, remark: '', at }].sort((left, right) => (validReference(book, left.reference) ? positionRank(book, left.reference.start) : Infinity) - (validReference(book, right.reference) ? positionRank(book, right.reference.start) : Infinity));
}

export function pageIndexForPosition(book, pages, position) {
  const rank = positionRank(book, position);
  if (rank < 0 || !pages.length) return 0;
  const index = pages.findIndex((page) => rank >= positionRank(book, page.start) && rank < positionRank(book, page.end));
  if (index >= 0) return index;
  // 段落末尾或章节间的空隙归入包含该段落的最后一页。
  let previous = 0;
  pages.forEach((page, pageIndex) => { if (positionRank(book, page.start) <= rank) previous = pageIndex; });
  return previous;
}

export function pageIndexForBoundary(book, pages, position) {
  const exactEnd = pages.findIndex((page) => positionRank(book, page.end) === positionRank(book, position));
  return exactEnd >= 0 ? exactEnd : pageIndexForPosition(book, pages, position);
}

export function annotationSegments(book, fragment, annotations) {
  const paragraphStart = { bookId: book.id, chapterId: fragment.chapterId, paragraphId: fragment.paragraphId, offset: 0 };
  const base = positionRank(book, paragraphStart);
  const ranges = annotations.filter((annotation) => validReference(book, annotation.reference)).map((annotation) => ({ annotation, start: Math.max(fragment.start, positionRank(book, annotation.reference.start) - base), end: Math.min(fragment.end, positionRank(book, annotation.reference.end) - base) })).filter((range) => range.end > range.start);
  const boundaries = [...new Set([fragment.start, fragment.end, ...ranges.flatMap((range) => [range.start, range.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1], annotations: ranges.filter((range) => range.start < boundaries[index + 1] && range.end > start).map((range) => range.annotation) }));
}

export function blankReadingState(book) {
  return { view: normalizeReadingView(), signature: bookSignature(book), position: firstPosition(book), settings: { fontSize: 18 }, readBoundary: null, bookmarks: [], highlights: [], notes: [], noteDraft: null, companionOpen: false, pane: 'reader', stack: [{ id: 'root', title: '书伴', thread: [], draft: '', quote: null, followup: null, context: null }], archived: [], returnPosition: null };
}

export function normalizeReadingState(book, input) {
  const base = blankReadingState(book);
  const value = input && typeof input === 'object' ? input : {};
  const stale = Boolean(value.signature && value.signature !== base.signature);
  const reference = (item) => {
    if (!item || item.start?.bookId !== book.id) return null;
    const pageNumber = Number.isInteger(item.pageNumber) && item.pageNumber > 0 ? item.pageNumber : null;
    if (!stale && validReference(book, item)) return makeReference(book, item.start, item.end, pageNumber);
    // 失效引用保留当时的摘录，明确禁用定位，不能猜测它在新正文中的位置。
    if (typeof item.text !== 'string' || !item.text) return null;
    const copy = (position) => ({ bookId: book.id, chapterId: typeof position?.chapterId === 'string' ? position.chapterId : '', paragraphId: typeof position?.paragraphId === 'string' ? position.paragraphId : '', offset: Number.isInteger(position?.offset) ? position.offset : 0 });
    return { start: copy(item.start), end: copy(item.end), pageNumber, chapterTitle: typeof item.chapterTitle === 'string' ? item.chapterTitle : '', text: item.text, unavailable: true };
  };
  const levels = (items) => (Array.isArray(items) ? items : []).filter((item) => item && typeof item.id === 'string').map((item) => ({
    id: item.id, parentId: typeof item.parentId === 'string' ? item.parentId : 'root', title: typeof item.title === 'string' ? item.title : '书伴', context: reference(item.context),
    scrollTop: Number.isFinite(item.scrollTop) && item.scrollTop >= 0 ? item.scrollTop : null,
    draft: typeof item.draft === 'string' ? item.draft : '', quote: reference(item.quote),
    followup: item.followup && reference(item.followup.reference) ? { messageId: String(item.followup.messageId || ''), reference: reference(item.followup.reference) } : null,
    thread: (Array.isArray(item.thread) ? item.thread : []).filter((message) => message && typeof message.text === 'string').map((message, index) => ({ id: typeof message.id === 'string' ? message.id : `${item.id}-restored-${index}`, who: message.who === '你' ? '你' : '书伴', text: message.text, reference: reference(message.reference), ...(typeof message.handover === 'string' ? { handover: message.handover } : {}) })),
  }));
  const stack = levels(value.stack);
  const discussion = (item) => item && typeof item.levelId === 'string' ? { levelId: item.levelId, messageId: typeof item.messageId === 'string' ? item.messageId : '' } : null;
  const notes = (Array.isArray(value.notes) ? value.notes : []).filter((note) => note && typeof note.body === 'string').map((note, index) => ({ id: typeof note.id === 'string' ? note.id : `restored-note-${index}`, body: note.body, origin: note.origin === 'companion' ? 'companion' : 'user', reference: reference(note.reference), discussion: discussion(note.discussion) }));
  // 旧的“想法”保留正文；没有可靠偏移时不通过文字搜索猜测锚点。
  (Array.isArray(value.thoughts) ? value.thoughts : []).forEach((thought, index) => { if (typeof thought?.note === 'string') notes.push({ id: `legacy-thought-${index}`, body: thought.note, origin: 'user', reference: null }); });
  const legacyParagraph = bookParagraphs(book).find((paragraph) => paragraph.chapterIndex === value.chapterIndex && paragraph.paragraphIndex === value.paragraphIndex);
  const legacyPosition = legacyParagraph ? { bookId: book.id, chapterId: legacyParagraph.chapterId, paragraphId: legacyParagraph.paragraphId, offset: 0 } : base.position;
  return { ...base,
    view: normalizeReadingView(value.view, value),
    position: !stale && validPosition(book, value.position) ? value.position : stale ? base.position : legacyPosition,
    settings: { fontSize: Number.isFinite(value.settings?.fontSize) ? Math.max(14, Math.min(32, value.settings.fontSize)) : 18 },
    readBoundary: !stale && validPosition(book, value.readBoundary) ? value.readBoundary : null,
    returnPosition: !stale && validPosition(book, value.returnPosition) ? value.returnPosition : null,
    companionOpen: Boolean(value.companionOpen), pane: value.pane === 'companion' ? 'companion' : 'reader',
    bookmarks: (Array.isArray(value.bookmarks) ? value.bookmarks : []).filter((item) => item && reference(item.reference)).filter((item, index, all) => all.findIndex((other) => positionKey(other.reference.start) === positionKey(item.reference.start) && Boolean(other.reference.unavailable) === Boolean(item.reference.unavailable)) === index).map((item, index) => ({ id: typeof item.id === 'string' ? item.id : `restored-bookmark-${index}`, reference: reference(item.reference), remark: typeof item.remark === 'string' ? item.remark : '', at: typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) ? item.at : new Date(0).toISOString() })).sort((a, b) => (validReference(book, a.reference) ? positionRank(book, a.reference.start) : Infinity) - (validReference(book, b.reference) ? positionRank(book, b.reference.start) : Infinity)),
    highlights: (Array.isArray(value.highlights) ? value.highlights : []).filter((item) => item && reference(item.reference)).map((item, index) => ({ id: typeof item.id === 'string' ? item.id : `restored-highlight-${index}`, reference: reference(item.reference) })), notes,
    noteDraft: value.noteDraft && typeof value.noteDraft.body === 'string' ? { ...(typeof value.noteDraft.id === 'string' ? { id: value.noteDraft.id } : {}), body: value.noteDraft.body, discussion: discussion(value.noteDraft.discussion), origin: value.noteDraft.origin === 'companion' ? 'companion' : 'user', reference: reference(value.noteDraft.reference) } : null,
    stack: stack.length && stack[0].id === 'root' ? stack : base.stack, archived: levels(value.archived),
  };
}

export function restoreReadingLibrary(books, saved) {
  const value = saved?.version === 1 ? saved : {};
  return { version: 1, activeId: books.some((book) => book.id === value.activeId) ? value.activeId : books[0]?.id, books: Object.fromEntries(books.map((book) => [book.id, normalizeReadingState(book, value.books?.[book.id])])) };
}

/** 示例回答只使用提供的引用；历史问答在追加时冻结位置，不读取后来的页码。 */
export function readingReply(book, reference, question, boundary) {
  const boundaryChapter = boundary ? book.chapters.findIndex((chapter) => chapter.id === boundary.chapterId) : 0;
  const scopeChapter = reference ? book.chapters.findIndex((chapter) => chapter.id === reference.end.chapterId) : -1;
  const future = book.chapters.find((chapter, index) => index > Math.max(boundaryChapter, scopeChapter) && (question.includes(chapter.title) || chapter.keywords.some((keyword) => question.includes(keyword))));
  if (future || /剧透|下一章|后面会/u.test(question)) return `示例书伴：已读边界尚未覆盖${future ? `「${future.title}」` : '后文'}。先讨论眼前引用；你可以在讨论范围中明确调整已读边界。这个提醒基于示例关键词，不代表真实模型级防剧透能力。`;
  const text = reference?.text || '';
  const excerpt = text.slice(0, 65);
  const topic = /线性一致性/u.test(text) ? '读到新值后不再返回旧值' : /批处理|管道|MapReduce/u.test(text) ? '把处理拆成可组合的步骤' : /最终一致性/u.test(text) ? '最终收敛不等于立即可见' : /网络|容错/u.test(text) ? '先区分系统假设与能够提供的保证' : '区分原文的观察、概念与结论';
  if (/举例|例子/u.test(question)) return `示例书伴：针对「${excerpt}」，可以用两个读者观察同一份更新来类比。先问他们在什么时刻看到了什么，再检验「${topic}」是否成立。这个类比帮助理解，不代替原文条件。`;
  if (/梳理|总结/u.test(question)) return `示例书伴：这一页可分成三步：观察「${excerpt}」提出的问题；提炼「${topic}」这个概念；再追问保证成立需要哪些条件。你可以挑其中一句继续讨论。`;
  if (/联系|前文/u.test(question)) return `示例书伴：把「${excerpt}」与前文的背景对照，重点看「${topic}」如何回应先前的问题。这里仅依据当前引用与示例章节作提示，不检索未提供的书籍内容。`;
  return `示例书伴：你问「${question}」。结合「${excerpt}」，先把「${topic}」作为理解线索，再分别检查它的适用条件与边界。你更想讨论概念、例子，还是自己的理解？`;
}

export function appendReadingDiscussion(state, reference, question, reply) {
  const snapshot = reference ? JSON.parse(JSON.stringify(reference)) : null;
  const messages = [{ id: readingId(), who: '你', text: question, reference: snapshot }, { id: readingId(), who: '书伴', text: reply, reference: snapshot }];
  return { ...state, stack: state.stack.map((level, index) => index === state.stack.length - 1 ? { ...level, scrollTop: null, draft: '', quote: null, followup: null, thread: [...level.thread, ...messages] } : level) };
}
