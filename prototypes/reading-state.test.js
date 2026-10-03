import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationSegments, appendReadingDiscussion, blankReadingState, bookParagraphs, bookSignature, firstPosition, makeReference, normalizeReadingState, pageIndexForBoundary, pageIndexForPosition, readingReply, restoreReadingLibrary, toggleBookmark, validReference } from './reading-state.js';
import { canTurnReadingPage, paginateBook } from './reading-pagination.js';

const book = { id: 'test-book', title: '示例书', chapters: [
  { id: 'one', title: '第一章', keywords: ['线性一致性'], paragraphs: ['相同的文字。'.repeat(80) + '🙂👨‍👩‍👧‍👦结尾', '相同的文字。相同的文字。', '线性一致性讨论读写保证。'] },
  { id: 'two', title: '第二章', keywords: ['批处理'], paragraphs: ['批处理通过管道组合步骤。'.repeat(10)] },
] };
const measure = (text) => Math.ceil([...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].length / 20) * 20 + 8;
const pages = paginateBook(book, { height: 108, measure });
const pos = (paragraph = 0, offset = 0, chapter = 0) => ({ bookId: book.id, chapterId: book.chapters[chapter].id, paragraphId: `${book.chapters[chapter].id}:p${paragraph + 1}`, offset });

test('长段落真实跨页：正文无遗漏、无重复、字形不拆断，每页测量高度不溢出', () => {
  assert.ok(pages.length > bookParagraphs(book).length);
  for (const paragraph of bookParagraphs(book)) {
    assert.equal(pages.flatMap((page) => page.fragments).filter((fragment) => fragment.paragraphId === paragraph.paragraphId).map((fragment) => fragment.text).join(''), paragraph.text);
  }
  for (const page of pages) {
    assert.ok(page.fragments.reduce((height, fragment) => height + measure(fragment.text), 0) <= 108);
    assert.equal(new Set(page.fragments.map((fragment) => fragment.chapterId)).size, 1);
    for (const fragment of page.fragments) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(fragment.text));
  }
  assert.deepEqual(paginateBook(book, { height: 0, measure }), []);
});

test('跨章顺序、首末页及锚点在变更页宽/高度后正确重映射', () => {
  assert.equal(pageIndexForPosition(book, pages, firstPosition(book)), 0);
  const chapterTwo = pages.findIndex((page) => page.chapterId === 'two');
  assert.equal(pageIndexForPosition(book, pages, pos(0, 0, 1)), chapterTwo);
  assert.equal(pageIndexForPosition(book, pages, pages.at(-1).end), pages.length - 1);
  const anchor = pages[3].start;
  const larger = paginateBook(book, { height: 228, measure });
  const next = larger[pageIndexForPosition(book, larger, anchor)];
  assert.ok(next.fragments.some((fragment) => fragment.paragraphId === anchor.paragraphId && fragment.start <= anchor.offset && fragment.end > anchor.offset));
  assert.notEqual(pageIndexForPosition(book, larger, anchor), 3);
  assert.equal(pageIndexForBoundary(book, pages, pages[0].end), 0);
  assert.equal(pageIndexForPosition(book, pages, pages[0].end), 1);
});

test('重复文字的不同位置不混淆；书签去重、取消和正文排序按稳定位置', () => {
  const first = makeReference(book, pos(1, 0), pos(1, 6), 5);
  const second = makeReference(book, pos(1, 6), pos(1, 12), 5);
  assert.equal(first.text, second.text);
  let bookmarks = toggleBookmark(book, [], second);
  bookmarks = toggleBookmark(book, bookmarks, first);
  assert.equal(bookmarks.length, 2);
  assert.equal(bookmarks[0].reference.start.offset, 0);
  assert.equal(toggleBookmark(book, bookmarks, first).length, 1);
  const fragment = { chapterId: 'one', paragraphId: 'one:p2', start: 0, end: 12 };
  const segments = annotationSegments(book, fragment, [{ id: 'second', reference: second }]);
  assert.deepEqual(segments.map((segment) => [segment.start, segment.end, segment.annotations.map((item) => item.id)]), [[0, 6, []], [6, 12, ['second']]]);
});

test('多处、重叠与跨段划线精确标记，跨页只呈现当前页交集', () => {
  const crossing = makeReference(book, pos(0, 470), pos(1, 3), 4);
  const overlap = makeReference(book, pos(1, 1), pos(1, 7), 4);
  const segments = annotationSegments(book, { chapterId: 'one', paragraphId: 'one:p2', start: 2, end: 9 }, [{ id: 'crossing', reference: crossing }, { id: 'overlap', reference: overlap }]);
  assert.deepEqual(segments.map((segment) => [segment.start, segment.end, segment.annotations.length]), [[2, 3, 2], [3, 7, 1], [7, 9, 0]]);
});

test('问答追加冻结引用，新问题和原讨论上下文互不改写', () => {
  const reference = makeReference(book, pages[0].start, pages[0].end, 1);
  const state = appendReadingDiscussion(blankReadingState(book), reference, '举个例子', '示例解释');
  reference.pageNumber = 50;
  reference.start.offset = 99;
  assert.equal(state.stack[0].thread[0].reference.pageNumber, 1);
  assert.equal(state.stack[0].thread[0].reference.start.offset, 0);
  assert.equal(state.stack[0].thread[1].reference.text, state.stack[0].thread[0].reference.text);
  assert.equal(state.readBoundary, null);
});

test('每本书独立恢复位置、设置、书签、划线、笔记、草稿、选区和深入讨论', () => {
  const other = { ...book, id: 'other' };
  const reference = makeReference(book, pos(1), pos(1, 6), 5);
  const state = { ...blankReadingState(book), position: pos(1, 2), readBoundary: pos(1, 6), bookmarks: toggleBookmark(book, [], reference), highlights: [{ id: 'mark', reference }], notes: [{ id: 'note', body: '我的记录', origin: 'user', reference }], noteDraft: { body: '未完成想法', origin: 'companion', reference }, settings: { fontSize: 28 }, companionOpen: true, stack: [blankReadingState(book).stack[0], { id: 'child', title: '深入', draft: '未发送问题', quote: reference, context: reference, thread: [] }] };
  const restored = restoreReadingLibrary([book, other], JSON.parse(JSON.stringify({ version: 1, activeId: book.id, books: { [book.id]: state } })));
  const saved = restored.books[book.id];
  assert.equal(saved.stack.length, 2);
  assert.equal(saved.stack[1].draft, '未发送问题');
  assert.deepEqual(saved.position, state.position);
  assert.deepEqual(saved.readBoundary, state.readBoundary);
  assert.equal(saved.noteDraft.body, '未完成想法');
  assert.equal(saved.noteDraft.origin, 'companion');
  assert.equal(saved.notes[0].reference.text, reference.text);
  assert.equal(saved.bookmarks.length, 1);
  assert.equal(saved.highlights.length, 1);
  assert.equal(saved.settings.fontSize, 28);
  assert.equal(restored.books.other.notes.length, 0);
  assert.deepEqual(restored.books.other.position, firstPosition(other));
});

test('缺失、旧格式、未知版本、失效锚点和正文版本变化均安全恢复', () => {
  assert.equal(restoreReadingLibrary([book], { version: 999, activeId: 'missing' }).activeId, book.id);
  assert.equal(normalizeReadingState(book, null).settings.fontSize, 18);
  const legacy = normalizeReadingState(book, { chapterIndex: 1, paragraphIndex: 0, thoughts: [{ note: '旧想法' }] });
  assert.equal(legacy.position.chapterId, 'two');
  assert.equal(legacy.notes[0].body, '旧想法');
  assert.equal(legacy.notes[0].reference, null);
  const reference = makeReference(book, pages[0].start, pages[0].end, 1);
  assert.equal(validReference(book, { ...reference, text: '已经不是这段文字' }), false);
  const expired = normalizeReadingState(book, { ...blankReadingState(book), signature: 'old-edition', position: pos(1), notes: [{ body: '保留笔记内容', reference }], bookmarks: [{ reference }], noteDraft: { body: '保留草稿', reference } });
  assert.equal(validReference(book, expired.notes[0].reference), false);
  assert.equal(expired.notes[0].reference.text, reference.text);
  assert.equal(expired.notes[0].body, '保留笔记内容');
  assert.equal(expired.noteDraft.body, '保留草稿');
  assert.equal(expired.bookmarks.length, 1);
  assert.equal(validReference(book, expired.bookmarks[0].reference), false);
  assert.deepEqual(expired.position, firstPosition(book));
  assert.notEqual(bookSignature({ ...book, chapters: [{ ...book.chapters[0], paragraphs: ['🙂'] }] }), bookSignature({ ...book, chapters: [{ ...book.chapters[0], paragraphs: ['🙃'] }] }));
  assert.doesNotThrow(() => normalizeReadingState(book, { bookmarks: [null, {}], stack: [{ id: 'root', title: {}, thread: [null, { text: '仍可读', who: {} }] }] }));
});

test('模拟回复随页文与提问变化，已读边界只约束后文章节提醒', () => {
  const consistency = makeReference(book, pos(2), pos(2, book.chapters[0].paragraphs[2].length), 6);
  const batching = makeReference(book, pos(0, 0, 1), pos(0, 14, 1), 7);
  assert.notEqual(readingReply(book, consistency, '解释这段', null), readingReply(book, batching, '解释这段', null));
  assert.notEqual(readingReply(book, consistency, '举个例子', null), readingReply(book, consistency, '梳理本页', null));
  assert.match(readingReply(book, consistency, '批处理是什么', pos()), /已读边界尚未覆盖/);
  assert.doesNotMatch(readingReply(book, batching, '批处理是什么', pos(0, 14, 1)), /已读边界尚未覆盖/);
  assert.doesNotMatch(readingReply(book, batching, '批处理是什么', null), /已读边界尚未覆盖/);
});

test('翻页快捷键避开输入、选项、交互标记、中文输入法和组合快捷键', () => {
  const editable = { closest: () => ({}) };
  const plain = { closest: () => null };
  assert.equal(canTurnReadingPage({ target: plain }), true);
  assert.equal(canTurnReadingPage({ target: editable }), false);
  assert.equal(canTurnReadingPage({ target: plain, isComposing: true }), false);
  assert.equal(canTurnReadingPage({ target: plain, keyCode: 229 }), false);
  assert.equal(canTurnReadingPage({ target: plain, ctrlKey: true }), false);
});


test('段落间距只分配给相邻片段，小视口能容纳一整行而不是退化成逐字页', () => {
  const small = { id: 'small', chapters: [{ id: 'ch', title: '一章', paragraphs: ['一整行文字', '下一整行'], keywords: [] }] };
  const oneLine = paginateBook(small, { height: 24, gap: 8, measure: () => 20 });
  assert.equal(oneLine.length, 2);
  assert.equal(oneLine[0].fragments[0].text, '一整行文字');
  const withSpacing = paginateBook(small, { height: 48, gap: 8, measure: () => 20 });
  assert.equal(withSpacing.length, 1);
  assert.equal(withSpacing[0].fragments.length, 2);
});
