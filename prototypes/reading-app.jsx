import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Library, Bookmark, List, MessageSquare, Pencil, X } from 'lucide-react';
import { makeReference, pageIndexForPosition, positionRank, readingId, toggleBookmark, validReference } from './reading-state.js';
import { hasUnsavedReadingNote, openReadingRight, readingPanelLayout, requestReadingNote, toggleReadingNavigation, toggleReadingRight } from './reading-view-state.js';
import { canTurnReadingPage, captureReadingSelection, createDOMMeasurer, paginateBook } from './reading-pagination.js';
import { ReadingNavigation, ReadingNotesPanel } from './reading-panels.jsx';
import { ReadingNoteCard, ReadingPopover, ReadingSelectionToolbar } from './reading-overlays.jsx';
import { ReadingCompanion } from './reading-companion.jsx';
import { ReadingPage } from './reading-page.jsx';
import './reading.css';
export { ReadingReference } from './reading-overlays.jsx';

export function ReadingApp(props) {
  const book = props.reading.books.find((item) => item.id === props.reading.activeId) || props.reading.books[0];
  return <ReadingBook key={book.id} {...props} book={book} />;
}

function ReadingBook({ book, reading, onHandToMultivac, onReport, noteTarget, narrow = false }) {
  const state = reading.readingOf(book.id);
  const root = useRef(null);
  const main = useRef(null);
  const viewport = useRef(null);
  const article = useRef(null);
  const fontButton = useRef(null);
  const moreButton = useRef(null);
  const navigationOpener = useRef(null);
  const rightOpener = useRef(null);
  const cardOpener = useRef(null);
  const reportRef = useRef(onReport);
  reportRef.current = onReport;
  const [width, setWidth] = useState(0);
  const [pages, setPages] = useState([]);
  const [pageInput, setPageInput] = useState('');
  const [selection, setSelection] = useState(null);
  const [popover, setPopover] = useState(null);
  const [cardContext, setCardContext] = useState({ pending: null, relatedIds: [] });
  const [focusSignal, setFocusSignal] = useState(0);
  const [flash, setFlash] = useState(null);
  const [notice, setNotice] = useState('');
  const layout = readingPanelLayout(state.view, width || 1200, narrow);
  const pageIndex = pageIndexForPosition(book, pages, state.position);
  const page = pages[pageIndex];
  const pageReference = page ? makeReference(book, page.start, page.end, pageIndex + 1) : null;
  const pageBookmarks = state.bookmarks.filter((item) => validReference(book, item.reference) && pageIndexForPosition(book, pages, item.reference.start) === pageIndex);
  const cardOpen = state.view.quickNoteOpen && Boolean(state.noteDraft);
  const patchView = (updater) => reading.patch(book.id, (current) => ({ ...current, view: updater(current.view) }));
  const restoreFocus = (ref) => (ref.current?.isConnected ? ref.current : article.current)?.focus({ preventScroll: true });
  const clearSelection = () => { setSelection(null); window.getSelection()?.removeAllRanges(); };
  const closePopover = (restore = true) => {
    if (restore) (popover === 'font' ? fontButton.current : moreButton.current)?.focus({ preventScroll: true });
    setPopover(null);
  };
  const closeCard = (restore = true) => {
    patchView((view) => ({ ...view, quickNoteOpen: false }));
    setCardContext({ pending: null, relatedIds: [] });
    if (restore) restoreFocus(cardOpener);
  };
  const closeNavigation = () => { patchView((view) => ({ ...view, navigation: { ...view.navigation, open: false }, compactPane: 'reader' })); restoreFocus(navigationOpener); };
  const closeRight = () => { patchView((view) => ({ ...view, right: { ...view.right, open: false }, compactPane: 'reader' })); restoreFocus(rightOpener); };
  const toggleNavigation = (tab, event) => {
    navigationOpener.current = event?.currentTarget || navigationOpener.current;
    closeCard(false); closePopover(false); clearSelection();
    patchView((view) => toggleReadingNavigation(view, tab, layout.left));
  };
  const toggleRight = (tab, event) => {
    rightOpener.current = event?.currentTarget || rightOpener.current;
    closeCard(false); closePopover(false); clearSelection();
    patchView((view) => toggleReadingRight(view, tab, layout.right));
  };
  const openCompanion = () => { patchView((view) => openReadingRight(view)); setFocusSignal((value) => value + 1); };

  // 正文导航只更新位置；桌面导航与回看面板继续留在原处。
  const navigate = (position, remember = false) => {
    clearSelection(); closePopover(false); setNotice('');
    reading.patch(book.id, (current) => ({ ...current, position, view: { ...current.view, compactPane: 'reader' }, returnPosition: remember ? current.returnPosition || current.position : current.returnPosition }));
  };
  const locate = (reference) => {
    if (!validReference(book, reference)) return;
    navigate(reference.start, true); setFlash(reference);
  };
  const turn = (index) => { if (pages[index]) { navigate(pages[index].start); article.current?.focus({ preventScroll: true }); } };
  const handOver = (text, reference) => onHandToMultivac(text, { title: `《${book.title}》`, kind: 'book', bookId: book.id, reference });
  const beginNote = (candidate, relatedIds = []) => {
    if (!cardOpen) cardOpener.current = document.activeElement;
    const conflict = hasUnsavedReadingNote(state) && (!candidate.id || state.noteDraft.id !== candidate.id);
    setCardContext({ pending: conflict ? candidate : null, relatedIds });
    reading.patch(book.id, (current) => ({ ...requestReadingNote(current, candidate), view: { ...current.view, quickNoteOpen: true, compactPane: 'reader' } }));
    clearSelection(); closePopover(false);
    if (!conflict && validReference(book, candidate.reference) && pageIndexForPosition(book, pages, candidate.reference.start) !== pageIndex) locate(candidate.reference);
  };
  const note = (reference = pageReference, body = '', origin = 'user', discussion = null) => beginNote({ reference, body, origin, discussion });
  const resumeDraft = () => {
    if (!state.noteDraft) return;
    cardOpener.current = document.activeElement;
    setCardContext({ pending: null, relatedIds: [] });
    patchView((view) => ({ ...view, quickNoteOpen: true, compactPane: 'reader' }));
    clearSelection(); closePopover(false);
    if (validReference(book, state.noteDraft.reference)) locate(state.noteDraft.reference);
  };
  const editNote = (saved, ids = []) => beginNote({ ...saved }, ids);
  const viewNotes = (ids) => {
    const saved = state.notes.find((item) => item.id === ids[0]);
    if (saved) editNote(saved, ids);
  };
  const saveNote = () => { reading.saveNote(book.id); closeCard(); setNotice('已保存'); };
  const discardDraft = () => {
    reading.patch(book.id, { noteDraft: cardContext.pending });
    if (cardContext.pending) setCardContext({ pending: null, relatedIds: [] });
    else closeCard();
  };
  const highlight = () => {
    const reference = selection?.reference;
    if (!validReference(book, reference)) return;
    reading.patch(book.id, (current) => current.highlights.some((item) => validReference(book, item.reference) && positionRank(book, item.reference.start) === positionRank(book, reference.start) && positionRank(book, item.reference.end) === positionRank(book, reference.end)) ? current : { ...current, highlights: [...current.highlights, { id: readingId(), reference }] });
    clearSelection(); setNotice('已划线');
  };
  const askSelection = () => {
    reading.updateLevel(book.id, (level) => ({ ...level, quote: selection.reference, followup: null }));
    clearSelection(); openCompanion();
  };
  const capture = () => {
    if (!layout.reader) return;
    const endpoints = captureReadingSelection(book, article.current);
    if (!endpoints) { setSelection(null); return; }
    const reference = makeReference(book, endpoints.start, endpoints.end, pageIndex + 1);
    if (!validReference(book, reference) || !reference.text.trim()) { setSelection(null); return; }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    setSelection({ reference, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } });
    if (cardOpen) closeCard(false);
  };

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root.current);
    setWidth(root.current.clientWidth);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    let frame;
    let live = true;
    const measure = () => {
      if (!live || !element.clientWidth || !element.clientHeight) return;
      const style = getComputedStyle(element);
      const width = Math.min(680, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 1;
      if (width <= 0 || height <= 0) return;
      const measurer = createDOMMeasurer(width, state.settings.fontSize);
      try { setPages(paginateBook(book, { height, measure: measurer.measure, gap: measurer.gap })); } finally { measurer.dispose(); }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element); measure(); document.fonts?.ready.then(schedule);
    return () => { live = false; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [book, state.settings.fontSize]);
  useEffect(() => { setPageInput(String(pageIndex + 1)); viewport.current?.scrollTo({ top: 0 }); }, [pageIndex]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const element = root.current;
    const resize = () => {
      const visual = window.visualViewport;
      const height = visual?.height || innerHeight;
      const top = Math.max(0, element.getBoundingClientRect().top - (visual?.offsetTop || 0));
      element.style.setProperty('--reading-right-visible-height', `${Math.max(100, height - top - element.querySelector('.reading-toolbar').clientHeight)}px`);
      element.dataset.keyboardCompact = String(height <= 460);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element); resize();
    window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize);
    return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); };
  }, []);
  useEffect(() => {
    const keydown = (event) => {
      if (!layout.reader || popover || !canTurnReadingPage(event) || !root.current?.contains(event.target) || window.getSelection()?.toString()) return;
      const direction = ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 0;
      if (direction) { event.preventDefault(); turn(pageIndex + direction); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  const chapterTitle = page?.chapterTitle || book.chapters[state.chapterIndex].title;
  useEffect(() => { reportRef.current?.({ title: `《${book.title}》`, detail: `${chapterTitle} · 第 ${pageIndex + 1} 页` }); }, [book.title, chapterTitle, pageIndex]);

  const draft = state.noteDraft;
  const relatedNotes = state.notes.filter((item) => cardContext.relatedIds.includes(item.id) || item.id === draft?.id || (validReference(book, item.reference) && validReference(book, draft?.reference) && positionRank(book, item.reference.start) === positionRank(book, draft.reference.start) && positionRank(book, item.reference.end) === positionRank(book, draft.reference.end)));
  const columns = layout.compact ? 'minmax(0, 1fr)' : [layout.left ? '256px' : '', 'minmax(0, 1fr)', layout.right ? '320px' : ''].filter(Boolean).join(' ');
  const rightTab = state.view.right.tab;
  const jumpPage = (value) => { const index = Number(value) - 1; if (Number.isInteger(index) && pages[index]) turn(index); else setNotice(`请输入 1–${pages.length} 的页码。`); };
  const escape = (event) => {
    if (event.key !== 'Escape') return;
    const noteMenu = event.target.closest('.reading-note-menu[open]');
    if (noteMenu) { noteMenu.open = false; noteMenu.querySelector('summary')?.focus(); }
    else if (popover) closePopover();
    else if (cardOpen) closeCard();
    else if (selection) { clearSelection(); article.current?.focus({ preventScroll: true }); }
    else if (event.target.closest('[id^="reading-bookmark-remark-"]')) {
      patchView((view) => ({ ...view, bookmarkEditingId: null }));
      [...root.current.querySelectorAll('[data-bookmark-editor]')].find((button) => button.dataset.bookmarkEditor === state.view.bookmarkEditingId)?.focus({ preventScroll: true });
    }
    else if (layout.left && (layout.compact || event.target.closest('.reading-left-navigation'))) closeNavigation();
    else if (layout.right && (layout.compact || event.target.closest('.reading-right-pane'))) closeRight();
    else return;
    event.preventDefault(); event.stopPropagation();
  };

  return <div ref={root} className="reading-workspace" data-layout={layout.compact ? 'compact' : 'desktop'} onKeyDownCapture={escape}>
    <header className="reading-toolbar">
      <div className="reading-book-heading">
        <button type="button" className="text-button reading-shelf-button" title="书架" aria-label="书架" aria-expanded={layout.left && state.view.navigation.tab === 'shelf'} aria-controls="reading-left-navigation" onClick={(event) => toggleNavigation('shelf', event)}><Library /><span>书架</span></button>
        <h1 title={`《${book.title}》`}>《{book.title}》</h1>
      </div>
      <nav className="reading-location-tools" aria-label="书籍导航">
        <button type="button" className="text-button" title="目录" aria-label="目录" aria-expanded={layout.left && state.view.navigation.tab === 'toc'} aria-controls="reading-left-navigation" onClick={(event) => toggleNavigation('toc', event)}><List /><span>目录</span></button>
        <button type="button" className="text-button" title={`书签 · ${state.bookmarks.length}`} aria-label={`书签，${state.bookmarks.length} 个`} aria-expanded={layout.left && state.view.navigation.tab === 'bookmarks'} aria-controls="reading-left-navigation" onClick={(event) => toggleNavigation('bookmarks', event)}><Bookmark /><span>书签</span></button>
      </nav>
      <div className="reading-tools">
        <button ref={fontButton} type="button" className="text-button reading-font-button" title="阅读字号" aria-label="正文字号" aria-haspopup="dialog" aria-expanded={popover === 'font'} aria-controls="reading-font-popover" onClick={() => { if (popover === 'font') closePopover(); else { closeCard(false); clearSelection(); setPopover('font'); } }}>Aa</button>
        <div className="reading-panel-switch" role="group" aria-label="阅读辅助面板">
          <button id="reading-open-companion" type="button" className="text-button" aria-expanded={layout.right && rightTab === 'companion'} aria-controls="reading-right-pane" onClick={(event) => toggleRight('companion', event)}><MessageSquare /><span>书伴</span></button>
          <button id="reading-open-notes" type="button" className="text-button" aria-label={draft ? '阅读笔记，有未保存草稿' : '阅读笔记'} aria-expanded={layout.right && rightTab === 'notes'} aria-controls="reading-right-pane" onClick={(event) => toggleRight('notes', event)}><Pencil /><span>笔记</span>{draft && <i className="reading-draft-dot" aria-hidden="true" />}</button>
        </div>
      </div>
    </header>
    <div className="reading-content" style={{ gridTemplateColumns: columns }}>
      <ReadingNavigation book={book} state={state} reading={reading} pages={pages} visible={layout.left} compact={layout.compact} onClose={closeNavigation} onTab={(tab) => patchView((view) => ({ ...view, navigation: { open: true, tab } }))} onChapter={(position) => { closeCard(false); navigate(position); }} onLocate={locate} onBook={(id) => {
        clearSelection(); reading.patch(id, (current) => ({ ...current, view: { ...current.view, navigation: { open: true, tab: 'shelf' }, activeSide: 'left', compactPane: 'reader', quickNoteOpen: false } })); reading.setActiveId(id);
      }} />
      <ReadingPage book={book} state={state} page={page} pageIndex={pageIndex} pages={pages} visible={layout.reader} mainRef={main} viewportRef={viewport} articleRef={article} pageInput={pageInput} onPageInput={setPageInput} onJump={jumpPage} onTurn={turn} onCapture={capture} flash={flash} bookmarked={Boolean(pageBookmarks.length)} onBookmark={() => { reading.patch(book.id, (current) => ({ ...current, bookmarks: toggleBookmark(book, current.bookmarks, pageBookmarks[0]?.reference || pageReference) })); setNotice(pageBookmarks.length ? '已移除当前页书签' : '已添加当前页书签'); }} onNote={draft ? resumeDraft : () => note()} onViewNotes={viewNotes} onRead={() => { reading.patch(book.id, { readBoundary: pageReference.end }); setNotice('已更新已读范围'); }} returnPosition={state.returnPosition} onReturn={() => { navigate(state.returnPosition); reading.patch(book.id, { returnPosition: null }); setFlash(null); }} onDismissReturn={() => reading.patch(book.id, { returnPosition: null })} />
      <aside id="reading-right-pane" className="reading-right-pane" aria-label="书伴与阅读笔记" hidden={!layout.right}>
        <header className="reading-right-header"><h2>{rightTab === 'companion' ? <MessageSquare /> : <Pencil />}{rightTab === 'companion' ? '书伴' : '阅读笔记'}</h2><button type="button" className="icon-button" title={layout.compact ? '返回正文' : '收起面板'} aria-label={layout.compact ? '返回正文' : '收起右侧面板'} onClick={closeRight}>{layout.compact ? <ArrowLeft /> : <X />}</button></header>
        <div id="reading-tabpanel-companion" className="reading-right-body" role="region" aria-labelledby="reading-open-companion" hidden={rightTab !== 'companion'}><ReadingCompanion book={book} state={state} reading={reading} pages={pages} visible={layout.right && rightTab === 'companion'} pageReference={pageReference} onLocate={locate} onNote={note} onHandOver={handOver} focusSignal={{ value: focusSignal, request: () => setFocusSignal((value) => value + 1) }} /></div>
        <div id="reading-tabpanel-notes" className="reading-right-body" role="region" aria-labelledby="reading-open-notes" hidden={rightTab !== 'notes'}><ReadingNotesPanel book={book} state={state} reading={reading} visible={layout.right && rightTab === 'notes'} page={page} onLocate={locate} onEdit={editNote} onNew={(reference) => note(reference || pageReference)} onResumeDraft={resumeDraft} noteTarget={noteTarget} /></div>
      </aside>
    </div>

    <div role="status" aria-live="polite" className="reading-status">{reading.persistenceError || notice}</div>
    {selection && !cardOpen && <ReadingSelectionToolbar rootRef={root} reference={selection.reference} rect={selection.rect} compact={layout.compact} onAsk={askSelection} onHighlight={highlight} onNote={() => note(selection.reference)} moreRef={moreButton} onMore={{ open: popover === 'selection', toggle: () => popover === 'selection' ? closePopover() : setPopover('selection') }} onClose={clearSelection} />}
    {popover === 'font' && <ReadingPopover rootRef={root} anchor={fontButton.current} kind="font" onClose={closePopover}><label className="reading-field">正文字号 · {state.settings.fontSize}px<input type="range" min="14" max="32" step="2" value={state.settings.fontSize} onChange={(event) => reading.patch(book.id, { settings: { fontSize: Number(event.target.value) } })} /></label></ReadingPopover>}
    {popover === 'selection' && selection && <ReadingPopover rootRef={root} anchor={moreButton.current} kind="selection" onClose={closePopover}>
      <button type="button" role="menuitem" onClick={() => { const reference = selection.reference; reading.deepen(book.id, { id: readingId(), text: reference.text, reference }); closePopover(false); clearSelection(); openCompanion(); }}>单独讨论</button>
      <button type="button" role="menuitem" onClick={() => { reading.collectNote(book, { origin: 'user', body: '阅读摘录', reference: selection.reference }); closePopover(false); clearSelection(); setNotice('已收进笔记'); }}>收进笔记「{noteTarget || '当前笔记'}」</button>
      <button type="button" role="menuitem" onClick={() => { handOver(`处理这段阅读内容：\n${selection.reference.text}`, selection.reference); closePopover(false); clearSelection(); }}>交给 Multivac</button>
    </ReadingPopover>}
    {cardOpen && <ReadingNoteCard rootRef={root} mainRef={main} compact={layout.compact} draft={draft} pending={cardContext.pending} relatedNotes={relatedNotes} persistenceError={reading.persistenceError} onChange={(body) => reading.patch(book.id, (current) => ({ ...current, noteDraft: { ...current.noteDraft, body } }))} onClose={() => closeCard()} onSave={saveNote} onDiscard={discardDraft} onContinue={() => setCardContext((current) => ({ ...current, pending: null }))} onSaveAndContinue={() => { reading.saveNote(book.id, cardContext.pending); setCardContext({ pending: null, relatedIds: [] }); }} onChoose={editNote} onLocate={locate} onReturnDiscussion={() => { const discussion = cardContext.pending?.discussion || draft.discussion; if (discussion?.levelId) reading.activateDiscussion(book.id, discussion.levelId); closeCard(false); openCompanion(); }} />}
  </div>;
}
