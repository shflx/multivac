import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, List, Bookmark, Highlighter, X, MessageSquare, Pencil, Library, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { positionRank, validBookReference, assistantQuoteWithinLimit, type AssistantBookQuote, type BookReference, type Book, type BookPosition } from '@multivac/contracts';
import { captureBookSelection, createPositionRanker, measureReadingPages, pageForPosition, type ReadingPage } from './reading-layout.js';
import { useReadingAnnotations } from './use-reading-annotations.js';
import { ReadingAnnotations, highlightedParagraphs } from './reading-annotations.js';
import { ensureBookCompanion, listReadingDiscussions, createReadingDiscussion } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { ReadingCompanion } from './reading-companion.js';
import { useReadingNotes } from './use-reading-notes.js';
import { ReadingNoteCard, ReadingNotesPanel, noteDraft } from './reading-notes.js';
import { restoreReadingScene, readingPanelLayout } from './reading-scene.js';
import { useNarrowViewport } from '../../app/narrow-viewport.js';
import { ReadingActionsMenu, useReadingFloating } from './reading-floating.js';
import { ReadingTabs } from './reading-tabs.js';
import { useReadingScope } from './use-reading-scope.js';

export function ReadingReader({ book, shelf, onImport, active, discussionRequest, positionRequest, onHandover, onReport }: { book: Book; shelf: ReactNode; onImport: () => void; active: boolean; discussionRequest?: { id: number; sessionId: string } | null; positionRequest?: { id: number; position: BookPosition; version: string } | null; onHandover: (quote: AssistantBookQuote) => void; onReport: (report: { title: string; reference: BookReference; discussionId: string | null } | null) => void }) {
  const [scene, setScene] = useState(() => restoreReadingScene(book));
  const narrow = useNarrowViewport();
  const [width, setWidth] = useState(1200);
  const layout = readingPanelLayout(scene, width, narrow);
  const [pages, setPages] = useState<ReadingPage[]>([]);
  const [measuredBox, setMeasuredBox] = useState('');
  const [input, setInput] = useState('');
  const [fontOpen, setFontOpen] = useState(false);
  const [error, setError] = useState('');
  function rightOpen(tab: 'companion' | 'notes' | 'highlights', value: SetStateAction<boolean>) {
    setScene(s => {
      const current = s.right.open && s.right.tab === tab;
      const open = typeof value === 'function' ? value(current) : value;
      if (!open && s.right.tab !== tab) return s;
      return { ...s, right: { open, tab }, lastSide: 'right', pane: open ? 'right' : 'reader' };
    });
  }
  const notesOpen = scene.right.open && scene.right.tab === 'notes';
  const setNotesOpen = (value: SetStateAction<boolean>) => rightOpen('notes', value);
  const [cardOpen, setCardOpen] = useState(false);
  const reportRef = useRef(onReport); reportRef.current = onReport;
  const notes = useReadingNotes(book.id);
  const readScope = useReadingScope(book.id);
  const [notice, setNotice] = useState('');
  const [located, setLocated] = useState<BookReference | null>(null);
  const companionOpen = scene.right.open && scene.right.tab === 'companion';
  const setCompanionOpen = (value: boolean) => rightOpen('companion', value);
  const [companionId, setCompanionId] = useState<string | null>(null);
  const [discussions, setDiscussions] = useState<import('@multivac/contracts').ReadingDiscussion[]>([]);
  const [discussionPending, setDiscussionPending] = useState<import('@multivac/contracts').CreateReadingDiscussion | null>(null);
  const [messageFocus, setMessageFocus] = useState<{ id: number; sessionId: string; piEntryId: string } | null>(null);
  const discussionBusy = useRef(false);
  const companionQuote = scene.companionQuote;
  const setCompanionQuote = (value: import('@multivac/contracts').BookReference | null) => setScene(s => ({ ...s, companionQuote: value, companionSource: null }));
  const discussion = discussions.find(d => d.sessionId === companionId) ?? null;
  const [selection, setSelection] = useState<ReturnType<typeof captureBookSelection>>(null);
  const annotations = useReadingAnnotations(book.id);
  const highlighted = useMemo(() => highlightedParagraphs(book, annotations.records, notes.state.notes, located), [book, annotations.records, notes.state.notes, located]);
  const root = useRef<HTMLElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fontButton = useRef<HTMLButtonElement>(null);
  const noteOpener = useRef<HTMLElement | null>(null);
  const navigationButton = useRef<HTMLButtonElement>(null);
  const rightButton = useRef<HTMLButtonElement>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const selectionFloating = useReadingFloating(root, selection?.rect ?? null, false, Boolean(selection));
  const fontFloating = useReadingFloating(root, fontButton.current, false, fontOpen);
  useLayoutEffect(() => {
    if (!active || !root.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry?.contentRect.width) setWidth(entry.contentRect.width); });
    observer.observe(root.current); return () => observer.disconnect();
  }, [active]);
  function navigation(tab: 'shelf' | 'toc' | 'bookmarks') {
    setScene(s => { const open = !(layout.left && s.navigationTab === tab); return { ...s, navigation: open, navigationTab: tab, lastSide: 'left', pane: open ? 'navigation' : 'reader' }; });
  }
  function returnReader(side: 'left' | 'right') {
    setScene(s => ({ ...s, pane: 'reader', ...(layout.compact ? {} : side === 'left' ? { navigation: false } : { right: { ...s.right, open: false } }) }));
    (side === 'left' ? navigationButton.current : rightButton.current)?.focus();
  }
  const ranker = useMemo(() => createPositionRanker(book), [book]);
  const pageIndex = pageForPosition(book, pages, scene.position, ranker);
  const page = pages[pageIndex];
  const pageReady = Boolean(page) && measuredBox === `${viewport.current?.clientWidth}/${viewport.current?.clientHeight}/${scene.fontSize}`;
  useEffect(() => { if (active && pageReady && page) reportRef.current({ title: book.title, reference: selection?.reference ?? page.reference, discussionId: companionId }); else reportRef.current(null); }, [active, book.title, page, pageReady, selection?.reference, companionId]);
  useEffect(() => () => reportRef.current(null), []);
  useEffect(() => {
    if (!positionRequest) return;
    if (positionRequest.version !== book.version) setError('来源版本已失效，未定位到新正文。');
    else locate(positionRequest.position);
  }, [positionRequest?.id]);
  function handover(quote: AssistantBookQuote) {
    if (!assistantQuoteWithinLimit(quote)) { setError('交接超过 4 KiB 引用限制，请缩短选区。'); return; }
    onHandover(quote);
  }
  const bookmarked = page && annotations.records.find(r => r.kind === 'bookmark' && validBookReference(book, r.reference) && positionRank(book, r.reference.start) >= positionRank(book, page.start) && positionRank(book, r.reference.start) < positionRank(book, page.end));
  const disabled = annotations.busy || Boolean(annotations.pending);
  async function openCompanion() {
    setCardOpen(false);
    setCompanionOpen(true); setNotesOpen(false);
    if (companionId) return;
    try {
      const root = await ensureBookCompanion(book.id);
      const all = await listReadingDiscussions(book.id); setDiscussions(all.discussions);
      const restored = all.discussions.find(d => d.sessionId === scene.discussionId);
      const next = restored ?? root;
      setCompanionId(next.sessionId); setScene(s => ({ ...s, discussionId: next.sessionId }));
    }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (active && companionOpen && !companionId) void openCompanion(); }, [active, companionOpen]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === book.id) void listReadingDiscussions(book.id).then(r => setDiscussions(r.discussions)).catch(e => setError((e as Error).message)); });
  function activateDiscussion(next: import('@multivac/contracts').ReadingDiscussion) {
    setCompanionId(next.sessionId); setCompanionOpen(true); setNotesOpen(false);
    setScene(s => {
      if (s.discussionId === next.sessionId) return s;
      const saved = { ...s.discussionScenes, ...(s.discussionId ? { [s.discussionId]: { quote: s.companionQuote, source: s.companionSource } } : {}) };
      const restored = saved[next.sessionId];
      return { ...s, discussionScenes: saved, discussionId: next.sessionId, companionQuote: restored?.quote ?? null, companionSource: restored?.source ?? null };
    });
  }
  async function returnDiscussion(source: import('@multivac/contracts').ReadingMessageSource) {
    try {
      const all = await listReadingDiscussions(book.id); setDiscussions(all.discussions);
      const target = all.discussions.find(d => d.sessionId === source.sessionId);
      if (!target) throw new Error('来源讨论已失效。');
      activateDiscussion(target); setCardOpen(false); setMessageFocus(s => ({ id: (s?.id ?? 0) + 1, ...source }));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    if (!discussionRequest) return;
    void listReadingDiscussions(book.id).then(all => {
      setDiscussions(all.discussions); const target = all.discussions.find(d => d.sessionId === discussionRequest.sessionId);
      if (target) activateDiscussion(target); else setError('来源讨论已失效。');
    }).catch(e => setError((e as Error).message));
  }, [book.id, discussionRequest?.id]);
  async function deepen(command: import('@multivac/contracts').CreateReadingDiscussion) {
    if (discussionBusy.current) return; discussionBusy.current = true; setDiscussionPending(command);
    try { const next = await createReadingDiscussion(book.id, command); setDiscussions(all => [...all.filter(d => d.sessionId !== next.sessionId), next]); activateDiscussion(next); setDiscussionPending(null); }
    catch (e) { setError((e as Error).message); }
    finally { discussionBusy.current = false; }
  }
  async function deepenSelection(reference: import('@multivac/contracts').BookReference) {
    const root = companionId ? { sessionId: companionId } : await ensureBookCompanion(book.id);
    await deepen({ commandId: crypto.randomUUID(), sessionId: `reading-discussion-${crypto.randomUUID()}`, parentSessionId: root.sessionId, source: { kind: 'selection', reference } });
  }
  async function editNote(candidate: import('@multivac/contracts').ReadingNoteDraft) {
    noteOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (layout.compact) setScene(s => ({ ...s, pane: 'reader' }));
    if (candidate.id === notes.draft?.id) { setCardOpen(true); return; }
    if (await notes.request(candidate)) setCardOpen(true);
  }
  function newNote(reference: import('@multivac/contracts').BookReference) { void editNote({ id: crypto.randomUUID(), body: '', reference, origin: 'user' }); }
  function closeNoteCard() {
    setCardOpen(false);
    if (noteOpener.current?.isConnected && noteOpener.current.checkVisibility()) noteOpener.current.focus(); else viewport.current?.focus();
  }
  function capture() { if (flow.current) setSelection(captureBookSelection(book, flow.current)); }
  function clearSelection() { setSelection(null); setMoreAnchor(null); window.getSelection()?.removeAllRanges(); }
  useEffect(() => {
    const changed = () => { const current = window.getSelection(); if (active && current && !current.isCollapsed && current.anchorNode && flow.current?.contains(current.anchorNode)) capture(); };
    document.addEventListener('selectionchange', changed); return () => document.removeEventListener('selectionchange', changed);
  }, [active, book]);
  useEffect(() => {
    try { localStorage.setItem(`multivac.reading.scene.${book.id}`, JSON.stringify(scene)); setError(''); }
    catch { setError('本机无法保存阅读现场。'); }
  }, [book.id, scene]);
  useLayoutEffect(() => {
    if (!active || !flow.current || !viewport.current) return;
    let frame = 0; let disposed = false;
    const measure = () => {
      if (!flow.current || !viewport.current || !viewport.current.clientWidth) return;
      const next = measureReadingPages(book, flow.current, viewport.current.clientWidth);
      setPages(next);
      setMeasuredBox(`${viewport.current.clientWidth}/${viewport.current.clientHeight}/${scene.fontSize}`);
    };
    const schedule = () => { setMeasuredBox(''); cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(viewport.current);
    void document.fonts.ready.then(() => { if (!disposed) schedule(); });
    document.fonts.addEventListener('loadingdone', schedule); schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); document.fonts.removeEventListener('loadingdone', schedule); };
  }, [book, active, scene.fontSize]);
  function turn(index: number) { const next = pages[Math.max(0, Math.min(pages.length - 1, index))]; if (next) setScene(s => ({ ...s, position: next.start })); setInput(''); setLocated(null); clearSelection(); }
  async function markRead() { if (pageReady && page && await readScope.mark(page.end)) setNotice('已更新已读范围'); }
  function toggleBookmark() {
    if (!pageReady || !page || disabled) return;
    void annotations.execute(bookmarked ? { commandId: crypto.randomUUID(), id: bookmarked.id, expectedRevision: bookmarked.revision, action: 'delete', kind: 'bookmark' } : { commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedRevision: 0, action: 'save', kind: 'bookmark', reference: page.reference });
  }
  function locate(position: BookPosition) { if (positionRank(book, position) < 0) { setError('原位置已失效。'); return; } setScene(s => ({ ...s, returnPosition: s.returnPosition ?? s.position, position, pane: 'reader' })); clearSelection(); }
  function locateReference(reference: BookReference) { if (validBookReference(book, reference)) { locate(reference.start); setLocated(reference); } else setError('原位置已失效，摘录仍保留。'); }
  const pageRead = Boolean(page && readScope.scope?.boundary && ranker(readScope.scope.boundary) >= ranker(page.end));
  return <section ref={root} className="reading-reader" data-compact={layout.compact} onKeyDown={event => {
    if (event.key === 'Escape' && fontOpen) { event.preventDefault(); event.stopPropagation(); setFontOpen(false); fontButton.current?.focus(); return; }
    if (event.key === 'Escape' && moreAnchor) { event.preventDefault(); event.stopPropagation(); setMoreAnchor(null); moreAnchor.focus(); return; }
    if (event.key === 'Escape' && cardOpen) { event.stopPropagation(); closeNoteCard(); return; }
    if (event.key === 'Escape' && selection) { event.stopPropagation(); clearSelection(); viewport.current?.focus(); return; }
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target instanceof HTMLElement && event.target.closest('input,textarea,button,select,[contenteditable=true],[role=button]')) return;
    if (event.key === 'Escape' && layout.compact && scene.pane !== 'reader') { event.preventDefault(); event.stopPropagation(); returnReader(scene.pane === 'navigation' ? 'left' : 'right'); return; }
    if (window.getSelection()?.toString()) return;
    const direction = ['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : ['ArrowRight', 'PageDown'].includes(event.key) ? 1 : 0;
    if (direction) { event.preventDefault(); if (pageReady) turn(pageIndex + direction); }
  }}>
    <header className="reading-toolbar">
      <div className="reading-book-heading">
        <button ref={navigationButton} className="reading-tool reading-shelf-button" title="书架" aria-label="书架" aria-expanded={layout.left && scene.navigationTab === 'shelf'} onClick={() => navigation('shelf')}><Library size={15} /><span>书架</span></button>
        <h2 title={book.title}>《{book.title}》</h2>
      </div>
      <nav className="reading-location-tools" aria-label="书籍导航">
        <button className="reading-tool" title="目录" aria-label="目录" aria-expanded={layout.left && scene.navigationTab === 'toc'} onClick={() => navigation('toc')}><List size={15} /><span>目录</span></button>
        <button className="reading-tool" title="书签" aria-label="书签导航" aria-expanded={layout.left && scene.navigationTab === 'bookmarks'} onClick={() => navigation('bookmarks')}><Bookmark size={15} /><span>书签</span></button>
      </nav>
      <div className="reading-tools">
        <button ref={fontButton} className="reading-tool reading-font-button" title="阅读字号" aria-label="字号" aria-expanded={fontOpen} aria-haspopup="dialog" onClick={() => { setFontOpen(v => !v); setCardOpen(false); clearSelection(); }}>Aa</button>
        <div className="reading-panel-switch" role="group" aria-label="阅读辅助面板">
          <button ref={rightButton} className="reading-tool" aria-label="书伴" aria-expanded={layout.right && companionOpen} onClick={() => layout.right && companionOpen ? setCompanionOpen(false) : void openCompanion()}><MessageSquare size={15} /><span>书伴</span></button>
          <button className="reading-tool" aria-label="阅读笔记" title={notes.draft ? '阅读笔记，有未保存草稿' : '阅读笔记'} aria-expanded={layout.right && notesOpen} onClick={() => { setNotesOpen(!(layout.right && notesOpen)); setCompanionOpen(false); clearSelection(); setCardOpen(false); }}><Pencil size={15} /><span>笔记</span>{notes.draft && <i className="reading-draft-dot" />}</button>
        </div>
      </div>
      {fontOpen && <div {...fontFloating} className="reading-font-popover" role="dialog" aria-label="字号设置"><label>字号 <input autoFocus type="range" min={14} max={32} step={2} value={scene.fontSize} onChange={event => setScene(s => ({ ...s, fontSize: Number(event.target.value) }))} /></label><button className="reading-icon" title="关闭字号设置" aria-label="关闭字号设置" onClick={() => { setFontOpen(false); fontButton.current?.focus(); }}><X size={16} /></button></div>}
    </header>
    {discussionPending && <button className="reading-retry" onClick={() => void deepen(discussionPending)}>重试创建原讨论</button>}
    <div className="reading-reader-body">
      <aside className="reading-left-pane" hidden={!layout.left} aria-label="阅读导航">
        <header><strong>{scene.navigationTab === 'shelf' ? '书架' : '阅读导航'}</strong><div>{scene.navigationTab === 'shelf' && <button className="reading-icon" title="导入书籍" aria-label="导入书籍" onClick={onImport}><Upload size={16} /></button>}<button className="reading-icon" title={layout.compact ? '返回正文' : '收起导航'} aria-label={layout.compact ? '返回正文' : '收起导航'} onClick={() => returnReader('left')}>{layout.compact ? <ArrowLeft size={16} /> : <X size={16} />}</button></div></header>
        {scene.navigationTab !== 'shelf' && <ReadingTabs label="导航视图" value={scene.navigationTab} tabs={[{ id: 'toc', label: '目录' }, { id: 'bookmarks', label: '书签' }]} change={navigationTab => setScene(s => ({ ...s, navigationTab, lastSide: 'left' }))} />}
        <div className="reading-library reading-navigation-shelf" hidden={scene.navigationTab !== 'shelf'}>{shelf}</div>
        <nav className="reading-toc" hidden={scene.navigationTab !== 'toc'} aria-label="目录">{book.chapters.filter(c => c.paragraphs.length).map(c => <button aria-label={c.title} aria-current={scene.position.chapterId === c.id ? 'location' : undefined} onClick={() => { setCardOpen(false); locate({ chapterId: c.id, paragraphId: c.paragraphs[0]!.id, offset: 0 }); }} key={c.id}>{c.title}<small>第 {pageForPosition(book, pages, { chapterId: c.id, paragraphId: c.paragraphs[0]!.id, offset: 0 }, ranker) + 1} 页</small></button>)}</nav>
        <div hidden={scene.navigationTab !== 'bookmarks'} className="reading-navigation-records"><ReadingAnnotations mode="bookmark" book={book} records={annotations.records} disabled={disabled} execute={c => void annotations.execute(c)} locate={locateReference} /></div>
      </aside>
      <div className="reading-page-main" hidden={!layout.reader}>
        <div className="reading-chapter-title"><span>{book.chapters.find(c => c.id === page?.start.chapterId)?.title}</span><div className="reading-page-actions">
          {scene.returnPosition && <><button className="reading-tool" aria-label="返回阅读处" onClick={() => { setScene(s => ({ ...s, position: s.returnPosition!, returnPosition: null })); setLocated(null); }}><ArrowLeft size={15} /><span>返回阅读处</span></button><button className="reading-icon" aria-label="关闭返回提示" title="关闭返回提示" onClick={() => { setScene(s => ({ ...s, returnPosition: null })); setLocated(null); }}><X size={15} /></button></>}
          <button className="reading-icon" title={bookmarked ? '取消当前页书签' : '添加当前页书签'} aria-label="当前页书签" aria-pressed={Boolean(bookmarked)} disabled={!pageReady || disabled} onClick={toggleBookmark}><Bookmark size={16} fill={bookmarked ? 'currentColor' : 'none'} /></button>
          <button className="reading-icon" title={notes.draft ? '继续阅读笔记草稿' : '为当前页写笔记'} aria-label="为当前页写笔记" disabled={!pageReady || !notes.loaded || notes.busy} onClick={() => notes.draft ? void editNote(notes.draft) : page && newNote(page.reference)}><Pencil size={16} />{notes.draft && <i className="reading-draft-dot" />}</button>
        </div></div>
        <div ref={viewport} className="reading-page-viewport" tabIndex={0} aria-label="书籍正文" onPointerDown={() => { setSelection(null); setMoreAnchor(null); }}>
          <div ref={flow} className="reading-flow" style={{ fontSize: scene.fontSize, transform: `translateX(-${pageIndex * (viewport.current?.clientWidth ?? 0)}px)` }}>
            {book.chapters.filter(c => c.paragraphs.length).map(c => <section className="reading-flow-chapter" key={c.id}>{c.paragraphs.map(p => {
              const parts = highlighted.get(p.id)!;
              const relatedIds = [...new Set(parts.flatMap(part => part.noteIds))];
              const viewNotes = (ids: string[]) => { const note = notes.state.notes.find(n => ids.includes(n.id)); if (note) void editNote(noteDraft(note)); };
              return <p key={p.id} data-paragraph={p.id} data-chapter={c.id}>{parts.map(part => part.marked || part.noteIds.length || part.located ? <mark key={part.start} className={part.located ? 'reading-located' : part.noteIds.length ? 'reading-note-mark' : ''} role={part.noteIds.length ? 'button' : undefined} tabIndex={part.noteIds.length ? 0 : undefined} title={part.noteIds.length ? '查看关联笔记' : '正文划线'} onClick={part.noteIds.length ? () => { if (!window.getSelection()?.toString()) viewNotes(part.noteIds); } : undefined} onKeyDown={part.noteIds.length ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); viewNotes(part.noteIds); } } : undefined}>{part.text}</mark> : <span key={part.start}>{part.text}</span>)}{relatedIds.length > 0 && <button className="reading-margin-note" title="查看此处笔记" aria-label="查看此处笔记" onClick={() => viewNotes(relatedIds)}><Pencil size={12} /></button>}</p>;
            })}</section>)}
          </div>
        </div>
        <footer className="reading-pagination">
          <button className="reading-command" aria-label="上一页" disabled={!pageReady || pageIndex === 0} onClick={() => turn(pageIndex - 1)}><ArrowLeft size={15} /><span>上一页</span></button>
          <form onSubmit={event => { event.preventDefault(); const n = Number(input); if (Number.isInteger(n) && n >= 1 && n <= pages.length) turn(n - 1); else setError('页码超出范围。'); }}><label>第 <input aria-label="页码" inputMode="numeric" value={input || String(pageIndex + 1)} onChange={event => setInput(event.target.value)} onFocus={event => event.target.select()} /></label><span> / {pages.length || '…'} 页</span><button className="reading-tool" aria-label="跳转" disabled={!pageReady}>跳转</button></form>
          <button className="reading-command" aria-label="下一页" disabled={!pageReady || pageIndex === pages.length - 1} onClick={() => turn(pageIndex + 1)}><span>下一页</span><ArrowRight size={15} /></button>
          <button className="reading-tool reading-mark-read" aria-label="本页已读" aria-pressed={pageRead} disabled={!pageReady || !readScope.scope || readScope.busy || Boolean(readScope.pending)} onClick={() => void markRead()}>本页已读</button>
        </footer>
      </div>
      <aside className="reading-right-pane" hidden={!layout.right} aria-label="阅读辅助面板">
        <header><h3>{scene.right.tab === 'companion' ? <MessageSquare size={15} /> : <Pencil size={15} />}{scene.right.tab === 'companion' ? '书伴' : '阅读笔记'}</h3><button className="reading-icon" title={layout.compact ? '返回正文' : '收起辅助面板'} aria-label={layout.compact ? '返回正文' : '收起辅助面板'} onClick={() => returnReader('right')}>{layout.compact ? <ArrowLeft size={16} /> : <X size={16} />}</button></header>
        <div className="reading-right-view" hidden={scene.right.tab !== 'notes'}>
          <div className="reading-records-toolbar"><ReadingTabs label="记录类型" value={scene.notesSection} tabs={[{ id: 'notes', label: `笔记 ${notes.state.notes.length}` }, { id: 'highlights', label: `划线 ${annotations.records.filter(r => r.kind === 'highlight').length}` }]} change={notesSection => setScene(s => ({ ...s, notesSection }))} /><button className="reading-icon" title="新建阅读笔记" aria-label="新建阅读笔记" disabled={!pageReady || notes.busy} onClick={() => page && newNote(page.reference)}><Plus size={15} /></button></div>
          <div hidden={scene.notesSection !== 'notes'} className="reading-record-view"><ReadingNotesPanel root={root} book={book} pageReference={page?.reference ?? null} notes={notes} locate={locateReference} edit={candidate => void editNote(candidate)} handover={note => handover({ sourceKind: 'book', sourceBook: note.reference, sourceNote: { id: note.id, revision: note.revision }, text: note.body, sourceTitle: book.title })} /></div>
          <div hidden={scene.notesSection !== 'highlights'} className="reading-record-view"><ReadingAnnotations mode="highlight" book={book} records={annotations.records} disabled={disabled} execute={c => void annotations.execute(c)} locate={locateReference} onNote={newNote} /></div>
        </div>
        {companionId && <div className="reading-companion-container" hidden={scene.right.tab !== 'companion'}><ReadingCompanion key={companionId} root={root} visible={active && layout.right && companionOpen} readScope={readScope} scopeLabel={companionQuote ? scene.companionSource ? '继续追问' : '选区' : discussion?.reference ? '单独讨论' : '当前页'} book={book} sessionId={companionId} discussion={discussion} discussions={discussions} messageFocus={messageFocus?.sessionId === companionId ? messageFocus : null} reference={companionQuote ?? discussion?.reference ?? (pageReady ? page!.reference : null)} pageReference={pageReady ? page!.reference : null} sourceMessage={scene.companionSource} onActivate={activateDiscussion} onFollowup={(reference, source) => setScene(s => ({ ...s, companionQuote: reference, companionSource: source }))} onDiscuss={source => void deepen({ commandId: crypto.randomUUID(), sessionId: `reading-discussion-${crypto.randomUUID()}`, parentSessionId: companionId, source: { kind: 'message', message: source } })} onNote={candidate => void editNote(candidate)} onHandover={handover} onClearQuote={() => setScene(s => ({ ...s, companionQuote: null, companionSource: null }))} onLocate={locateReference} /></div>}
      </aside>
    </div>
    <div className="reading-status" role="status" aria-live="polite">{error || notes.error || annotations.error || readScope.error || notice}</div>
    {readScope.error && <div className="reading-scope-recovery" role="alert" aria-label="已读范围恢复">{readScope.pending && <button className="reading-command" disabled={readScope.busy} onClick={() => void readScope.retry()}>重试已读标记</button>}<button className="reading-command" disabled={readScope.busy} onClick={readScope.reconcile}>重新读取已读范围</button></div>}
    {annotations.pending && annotations.error && <button className="reading-retry" onClick={() => void annotations.execute(annotations.pending!)}>重试原标注命令</button>}
    {selection && <div {...selectionFloating} className="reading-selection-toolbar" role="toolbar" aria-label="选区操作" onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}><span title={selection.reference.text}>「{selection.reference.text.slice(0,36)}」</span><div><button className="reading-command" aria-label="问书伴" onClick={() => { setCompanionQuote(selection.reference); clearSelection(); void openCompanion(); }}><MessageSquare size={15} />问书伴</button><button className="reading-command" aria-label="划线" disabled={disabled} onClick={() => { void annotations.execute({ commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedRevision: 0, action: 'save', kind: 'highlight', reference: selection.reference }); clearSelection(); }}><Highlighter size={15} />划线</button><button className="reading-command" aria-label="写笔记" disabled={!notes.loaded || notes.busy} onClick={() => { newNote(selection.reference); clearSelection(); }}><Pencil size={15} />写笔记</button><button className="reading-icon" title="更多选区操作" aria-label="更多选区操作" aria-haspopup="menu" aria-expanded={Boolean(moreAnchor)} onClick={event => setMoreAnchor(event.currentTarget)}><MoreHorizontal size={15} /></button><button className="reading-icon" title="清除选区" aria-label="清除选区" onClick={clearSelection}><X size={15} /></button></div></div>}
    {selection && moreAnchor && <ReadingActionsMenu root={root} anchor={moreAnchor} close={() => setMoreAnchor(null)} label="选区更多操作" actions={[
      { label: '单独讨论选区', run: () => { void deepenSelection(selection.reference).catch(e => setError((e as Error).message)); clearSelection(); } },
      { label: '交给 Multivac', run: () => { handover({ sourceKind: 'book', sourceBook: selection.reference, text: selection.reference.text, sourceTitle: book.title }); clearSelection(); } },
    ]} />}
    {cardOpen && <ReadingNoteCard root={root} book={book} notes={notes} edit={candidate => void editNote(candidate)} returnDiscussion={source => void returnDiscussion(source)} close={closeNoteCard} locate={locateReference} />}
  </section>;
}
