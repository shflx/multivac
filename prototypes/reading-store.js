import { useCallback, useEffect, useState } from 'react';
import { activateReadingDiscussion, openReadingRight, saveReadingNote } from './reading-view-state.js';
import { isArrangementIntent } from './ui-state.js';
import { READING_STORAGE_KEY, restoreReadingLibrary, bookParagraphs, appendReadingDiscussion, readingReply, readingId, validReference } from './reading-state.js';

export function useReading({ books, onCollect }) {
  const [persistenceError, setPersistenceError] = useState('');
  const [library, setLibrary] = useState(() => {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(READING_STORAGE_KEY) || 'null'); } catch { saved = null; }
    return restoreReadingLibrary(books, saved);
  });
  useEffect(() => {
    try { localStorage.setItem(READING_STORAGE_KEY, JSON.stringify(library)); setPersistenceError(''); }
    catch { setPersistenceError('浏览器暂时无法保存阅读记录，请在离开前收进笔记。'); }
  }, [library]);
  const patch = useCallback((bookId, updater) => setLibrary((current) => ({ ...current, books: { ...current.books, [bookId]: typeof updater === 'function' ? updater(current.books[bookId]) : { ...current.books[bookId], ...updater } } })), []);
  const updateLevel = (bookId, updater) => patch(bookId, (state) => ({ ...state, stack: state.stack.map((level, index) => index === state.stack.length - 1 ? updater(level) : level) }));
  const readingOf = (bookId) => {
    const state = library.books[bookId];
    const book = books.find((item) => item.id === bookId);
    const paragraph = bookParagraphs(book).find((item) => item.paragraphId === state.position.paragraphId && item.chapterId === state.position.chapterId);
    return { ...state, chapterIndex: paragraph?.chapterIndex || 0, paragraphIndex: paragraph?.paragraphIndex || 0 };
  };
  return {
    books, activeId: library.activeId, persistenceError, readingOf, patch, updateLevel,
    openCompanion: (bookId) => patch(bookId, (state) => ({ ...state, view: openReadingRight(state.view) })),
    activateDiscussion: (bookId, id) => patch(bookId, (state) => activateReadingDiscussion(state, id)),
    setActiveId: (activeId) => { if (books.some((book) => book.id === activeId)) setLibrary((current) => ({ ...current, activeId })); },
    // 应用 Shell 继续从这里读取伴随会话的摘要；笔记助手保持原来的实现。
    threads: { of: (bookId) => ({ stack: library.books[bookId].stack, quote: library.books[bookId].stack.at(-1).quote?.text || '' }) },
    ask: (bookId, reference, question) => {
      if (!question.trim()) return;
      patch(bookId, (state) => {
        const book = books.find((item) => item.id === bookId);
        const arrangement = isArrangementIntent(question);
        const reply = arrangement ? '这是在安排工作，可以交给 Multivac；书伴只陪你讨论当前引用。' : readingReply(book, reference, question.trim(), state.readBoundary);
        const next = appendReadingDiscussion(state, reference, question.trim(), reply);
        if (arrangement) next.stack.at(-1).thread.at(-1).handover = `${question}\n${reference?.text || ''}`;
        return next;
      });
    },
    deepen: (bookId, message) => patch(bookId, (state) => {
      const id = `discussion-${message.id}`;
      const previous = state.archived.find((level) => level.id === id);
      return { ...state, stack: [...state.stack, previous || { id, parentId: state.stack.at(-1).id, title: message.text.slice(0, 16), context: message.reference, quote: null, followup: null, draft: '', thread: [] }], archived: state.archived.filter((level) => level.id !== id) };
    }),
    resumeDiscussion: (bookId, discussionId) => patch(bookId, (state) => {
      const discussion = state.archived.find((item) => item.id === discussionId && item.parentId === state.stack.at(-1).id);
      return discussion ? { ...state, stack: [...state.stack, discussion], archived: state.archived.filter((item) => item.id !== discussionId) } : state;
    }),
    back: (bookId) => patch(bookId, (state) => state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1), archived: [...state.archived.filter((level) => level.id !== state.stack.at(-1).id), state.stack.at(-1)] } : state),
    saveNote: (bookId, nextDraft = null) => patch(bookId, (state) => saveReadingNote(state, readingId(), nextDraft)),
    collectNote: (book, note) => {
      const paragraph = validReference(book, note.reference) ? bookParagraphs(book).find((item) => item.paragraphId === note.reference.start.paragraphId) : null;
      const source = `《${book.title}》${paragraph ? ` · ${paragraph.chapterTitle} · 第 ${paragraph.paragraphIndex + 1} 段 · 字符 ${note.reference.start.offset + 1}` : note.reference?.unavailable ? ' · 原位置已失效的旧版摘录' : ''}`;
      onCollect(`${note.origin === 'companion' ? '书伴解释（示例）' : '我的阅读记录'}\n${note.body}${note.reference ? `\n原文：${note.reference.text}` : ''}`, source);
    },
  };
}
