import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, List, Type as FontIcon, Bookmark, Highlighter, X, MessageSquare, Pencil, NotebookPen, Library, BookMarked, MoreHorizontal } from 'lucide-react';
import { positionRank, validBookReference, assistantQuoteWithinLimit, type AssistantBookQuote, type BookReference, type CollectReadingCommand, type Book, type BookPosition } from '@multivac/contracts';
import { captureBookSelection, createPositionRanker, measureReadingPages, pageForPosition, type ReadingPage } from './reading-layout.js';
import { useReadingAnnotations } from './use-reading-annotations.js';
import { ReadingAnnotations, highlightedParagraphs } from './reading-annotations.js';
import { ensureBookCompanion, listReadingDiscussions, createReadingDiscussion } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { ReadingCompanion } from './reading-companion.js';
import { useReadingNotes } from './use-reading-notes.js';
import { ReadingNoteCard, ReadingNotesPanel, noteDraft } from './reading-notes.js';
import { ReadingCollectCard } from './reading-collection.js';
import { restoreReadingScene, readingPanelLayout } from './reading-scene.js';
import { useNarrowViewport } from '../../app/narrow-viewport.js';
import { ReadingActionsMenu, useReadingFloating } from './reading-floating.js';
import { ReadingTabs } from './reading-tabs.js';

export function ReadingReader({ book, shelf, active, discussionRequest, positionRequest, onHandover, onReport, onOpenNotes }: { book: Book; shelf: ReactNode; active: boolean; discussionRequest?: { id: number; sessionId: string } | null; positionRequest?: { id: number; position: BookPosition; version: string } | null; onHandover: (quote: AssistantBookQuote) => void; onReport: (report: { title: string; reference: BookReference; discussionId: string | null } | null) => void; onOpenNotes: (targetId: string) => void }) {
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
  const recordsOpen = scene.right.open && scene.right.tab === 'highlights';
  const notesOpen = scene.right.open && scene.right.tab === 'notes';
  const setRecordsOpen = (value: SetStateAction<boolean>) => rightOpen('highlights', value);
  const setNotesOpen = (value: SetStateAction<boolean>) => rightOpen('notes', value);
  const [cardOpen, setCardOpen] = useState(false);
  const [collectSource, setCollectSource] = useState<CollectReadingCommand['source'] | null>(null);
  const reportRef = useRef(onReport); reportRef.current = onReport;
  const notes = useReadingNotes(book.id);
  const noteParagraphs = useMemo(() => {
    const map = new Map<string, import('@multivac/contracts').ReadingNote[]>();
    for (const note of notes.state.notes) {
      if (!validBookReference(book, note.reference)) continue;
      const id = note.reference.start.paragraphId; map.set(id, [...(map.get(id) ?? []), note]);
    }
    return map;
  }, [book, notes.state.notes]);
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
  const highlighted = useMemo(() => highlightedParagraphs(book, annotations.records), [book, annotations.records]);
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
    setCompanionOpen(true); setRecordsOpen(false); setNotesOpen(false);
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
    setCompanionId(next.sessionId); setCompanionOpen(true); setNotesOpen(false); setRecordsOpen(false);
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
  function turn(index: number) { const next = pages[Math.max(0, Math.min(pages.length - 1, index))]; if (next) setScene(s => ({ ...s, position: next.start })); setInput(''); clearSelection(); }
  function locate(position: BookPosition) { if (positionRank(book, position) < 0) { setError('原位置已失效。'); return; } setScene(s => ({ ...s, returnPosition: s.returnPosition ?? s.position, position, pane: 'reader' })); }
  return <section ref={root} className="reading-reader" data-compact={layout.compact} onKeyDown={event => {
    if (event.key === 'Escape' && fontOpen) { event.preventDefault(); event.stopPropagation(); setFontOpen(false); fontButton.current?.focus(); return; }
    if (event.key === 'Escape' && moreAnchor) { event.preventDefault(); event.stopPropagation(); setMoreAnchor(null); moreAnchor.focus(); return; }
    if (event.key === 'Escape' && cardOpen) { event.stopPropagation(); closeNoteCard(); return; }
    if (event.key === 'Escape' && selection) { event.stopPropagation(); clearSelection(); viewport.current?.focus(); return; }
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target instanceof HTMLElement && event.target.closest('input,textarea,button,select,[contenteditable=true]')) return;
    if (event.key === 'Escape' && layout.compact && scene.pane !== 'reader') { event.preventDefault(); event.stopPropagation(); returnReader(scene.pane === 'navigation' ? 'left' : 'right'); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); if (pageReady) turn(pageIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
  }}>
    <header className="reading-toolbar"><button ref={navigationButton} className="reading-command" title="书架" aria-label="书架" aria-expanded={layout.left && scene.navigationTab === 'shelf'} onClick={() => navigation('shelf')}><Library size={18} /></button><h2>{book.title}</h2><button className="reading-command" title="目录" aria-label="目录" aria-expanded={layout.left && scene.navigationTab === 'toc'} onClick={() => navigation('toc')}><List size={18} /></button><button className="reading-command" title="书签导航" aria-label="书签导航" aria-expanded={layout.left && scene.navigationTab === 'bookmarks'} onClick={() => navigation('bookmarks')}><BookMarked size={18} /></button><button className="reading-command" title="阅读记录" aria-label="阅读记录" aria-expanded={layout.right && recordsOpen} onClick={() => setRecordsOpen(!(layout.right && recordsOpen))}><Highlighter size={18} /></button><button className="reading-command" title="当前页书签" aria-label="当前页书签" aria-pressed={Boolean(bookmarked)} disabled={!page || disabled} onClick={() => {
      if (!page) return;
      void annotations.execute(bookmarked ? { commandId: crypto.randomUUID(), id: bookmarked.id, expectedRevision: bookmarked.revision, action: 'delete', kind: 'bookmark' } : { commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedRevision: 0, action: 'save', kind: 'bookmark', reference: page.reference });
    }}><Bookmark size={18} /></button><button ref={fontButton} className="reading-command" title="字号" aria-label="字号" aria-expanded={fontOpen} onClick={() => setFontOpen(v => !v)}><FontIcon size={18} /></button>
      <button ref={rightButton} className="reading-command" title="书伴" aria-label="书伴" aria-expanded={layout.right && companionOpen} onClick={() => layout.right && companionOpen ? setCompanionOpen(false) : void openCompanion()}><MessageSquare size={18} /></button>
      <button className="reading-command" title="阅读笔记" aria-label="阅读笔记" aria-expanded={layout.right && notesOpen} onClick={() => { setNotesOpen(!(layout.right && notesOpen)); setRecordsOpen(false); setCompanionOpen(false); }}><Pencil size={18} /></button><button className="reading-command" title="为当前页写笔记" aria-label="为当前页写笔记" disabled={!page || !notes.loaded || notes.busy} onClick={() => page && newNote(page.reference)}><NotebookPen size={16} /></button>
      {fontOpen && <div {...fontFloating} className="reading-font-popover" role="dialog" aria-label="字号设置"><label>字号 <input autoFocus type="range" min={14} max={32} step={2} value={scene.fontSize} onChange={event => setScene(s => ({ ...s, fontSize: Number(event.target.value) }))} /></label><button className="reading-command" title="关闭字号设置" aria-label="关闭字号设置" onClick={() => { setFontOpen(false); fontButton.current?.focus(); }}><X size={16} /></button></div>}
    </header>
    {error && <p role="alert">{error}</p>}
    {notes.error && !cardOpen && <p role="alert">{notes.error}</p>}
    {discussionPending && <button className="reading-command" onClick={() => void deepen(discussionPending)}>重试创建原讨论</button>}
    {annotations.error && <div role="alert">{annotations.error}{annotations.pending && <><button disabled={annotations.busy} onClick={() => void annotations.execute(annotations.pending!)}>重试原命令</button><button disabled={annotations.busy} onClick={annotations.dismiss}>重新读取记录</button></>}</div>}
    <div className="reading-reader-body">
      <aside className="reading-left-pane" hidden={!layout.left} aria-label="阅读导航"><header><strong>阅读导航</strong><button className="reading-command" title={layout.compact ? '返回正文' : '收起导航'} aria-label={layout.compact ? '返回正文' : '收起导航'} onClick={() => returnReader('left')}>{layout.compact ? <ArrowLeft size={16} /> : <X size={16} />}</button></header><ReadingTabs label="导航视图" value={scene.navigationTab} tabs={[{ id: 'shelf', label: '书架' }, { id: 'toc', label: '目录' }, { id: 'bookmarks', label: '书签' }]} change={navigationTab => setScene(s => ({ ...s, navigationTab, lastSide: 'left' }))} />
        <div className="reading-library reading-navigation-shelf" hidden={scene.navigationTab !== 'shelf'}>{shelf}</div>
        <nav className="reading-toc" hidden={scene.navigationTab !== 'toc'} aria-label="目录">{book.chapters.filter(c => c.paragraphs.length).map(c => <button onClick={() => locate({ chapterId: c.id, paragraphId: c.paragraphs[0]!.id, offset: 0 })} key={c.id}>{c.title}</button>)}</nav>
        <div hidden={scene.navigationTab !== 'bookmarks'} className="reading-navigation-records"><ReadingAnnotations mode="bookmark" book={book} records={annotations.records} disabled={disabled} execute={c => void annotations.execute(c)} locate={r => locate(r.start)} /></div>
      </aside>
      <div className="reading-page-main" hidden={!layout.reader}>
        <div className="reading-chapter-title"><span>{book.chapters.find(c => c.id === page?.start.chapterId)?.title}</span>{scene.returnPosition && <button className="reading-command" onClick={() => setScene(s => ({ ...s, position: s.returnPosition!, returnPosition: null }))}><ArrowLeft size={16} />返回阅读处</button>}</div>
        <div ref={viewport} className="reading-page-viewport" tabIndex={0} aria-label="书籍正文" onPointerDown={() => { setSelection(null); setMoreAnchor(null); }}>
          <div ref={flow} className="reading-flow" style={{ fontSize: scene.fontSize, transform: `translateX(-${pageIndex * (viewport.current?.clientWidth ?? 0)}px)` }}>
            {book.chapters.filter(c => c.paragraphs.length).map(c => <section className="reading-flow-chapter" key={c.id}>{c.paragraphs.map(p => {
              const related = noteParagraphs.get(p.id) ?? [];
              return <p key={p.id} data-paragraph={p.id} data-chapter={c.id}>{highlighted.get(p.id)!.map(part => part.marked ? <mark key={part.start}>{part.text}</mark> : <span key={part.start}>{part.text}</span>)}{related.length > 0 && <button className="reading-margin-note" title="查看此处笔记" aria-label="查看此处笔记" onClick={() => void editNote(noteDraft(related[0]!))}><Pencil size={14} /></button>}</p>;
            })}</section>)}
          </div>
        </div>
        <footer className="reading-pagination"><button className="reading-command" title="上一页" aria-label="上一页" disabled={!page || pageIndex === 0} onClick={() => turn(pageIndex - 1)}><ArrowLeft size={18} /></button>
          <form onSubmit={event => { event.preventDefault(); const n = Number(input); if (Number.isInteger(n) && n >= 1 && n <= pages.length) turn(n - 1); else setError('页码超出范围。'); }}><label>页码 <input aria-label="页码" inputMode="numeric" value={input || String(pageIndex + 1)} onChange={event => setInput(event.target.value)} onFocus={event => event.target.select()} /></label><span> / {pages.length || '...'} 页</span><button className="reading-command" title="跳转" aria-label="跳转"><ArrowRight size={16} /></button></form>
          <button className="reading-command" title="下一页" aria-label="下一页" disabled={!page || pageIndex === pages.length - 1} onClick={() => turn(pageIndex + 1)}><ArrowRight size={18} /></button>
        </footer>
      </div>
      <aside className="reading-right-pane" hidden={!layout.right} aria-label="阅读辅助面板"><header><ReadingTabs label="辅助视图" value={scene.right.tab} tabs={[{ id: 'companion', label: '书伴' }, { id: 'notes', label: '笔记' }, { id: 'highlights', label: '划线' }]} change={tab => { if (tab === 'companion') void openCompanion(); else if (tab === 'notes') setNotesOpen(true); else setRecordsOpen(true); }} /><button className="reading-command" title={layout.compact ? '返回正文' : '收起辅助面板'} aria-label={layout.compact ? '返回正文' : '收起辅助面板'} onClick={() => returnReader('right')}>{layout.compact ? <ArrowLeft size={16} /> : <X size={16} />}</button></header>
        <div className="reading-right-view" hidden={scene.right.tab !== 'highlights'}><ReadingAnnotations mode="highlight" book={book} records={annotations.records} disabled={disabled} execute={c => void annotations.execute(c)} locate={reference => locate(reference.start)} /></div>
        <div className="reading-right-view" hidden={scene.right.tab !== 'notes'}><ReadingNotesPanel root={root} book={book} notes={notes} locate={r => locate(r.start)} edit={candidate => void editNote(candidate)} collect={note => setCollectSource({ kind: 'reading-note', bookId: book.id, noteId: note.id, noteRevision: note.revision })} handover={note => handover({ sourceKind: 'book', sourceBook: note.reference, sourceNote: { id: note.id, revision: note.revision }, text: note.body, sourceTitle: book.title })} /></div>
        {companionId && <div className="reading-companion-container" hidden={scene.right.tab !== 'companion'}><ReadingCompanion key={companionId} root={root} visible={active && layout.right && companionOpen} book={book} sessionId={companionId} discussion={discussion} discussions={discussions} messageFocus={messageFocus?.sessionId === companionId ? messageFocus : null} reference={companionQuote ?? discussion?.reference ?? (pageReady ? page!.reference : null)} pageReference={pageReady ? page!.reference : null} sourceMessage={scene.companionSource} onActivate={activateDiscussion} onFollowup={(reference, source) => setScene(s => ({ ...s, companionQuote: reference, companionSource: source }))} onDiscuss={source => void deepen({ commandId: crypto.randomUUID(), sessionId: `reading-discussion-${crypto.randomUUID()}`, parentSessionId: companionId, source: { kind: 'message', message: source } })} onNote={candidate => void editNote(candidate)} onCollect={source => setCollectSource({ kind: 'companion', bookId: book.id, message: source })} onHandover={handover} onClearQuote={() => setScene(s => ({ ...s, companionQuote: null, companionSource: null }))} onLocate={r => locate(r.start)} /></div>}
      </aside>
    </div>
    {selection && <div {...selectionFloating} className="reading-selection-toolbar" role="toolbar" aria-label="选区操作" onPointerDown={event => { if (event.pointerType === 'mouse') event.preventDefault(); }}><button className="reading-command" title="问书伴" aria-label="问书伴" onClick={() => { setCompanionQuote(selection.reference); clearSelection(); void openCompanion(); }}><MessageSquare size={16} /></button><button className="reading-command" title="划线" aria-label="划线" disabled={disabled} onClick={() => { void annotations.execute({ commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedRevision: 0, action: 'save', kind: 'highlight', reference: selection.reference }); clearSelection(); }}><Highlighter size={16} /></button><button className="reading-command" title="写笔记" aria-label="写笔记" disabled={!notes.loaded || notes.busy} onClick={() => { newNote(selection.reference); clearSelection(); }}><Pencil size={16} /></button><button className="reading-command" title="更多选区操作" aria-label="更多选区操作" aria-haspopup="menu" aria-expanded={Boolean(moreAnchor)} onClick={event => setMoreAnchor(event.currentTarget)}><MoreHorizontal size={16} /></button><button className="reading-command" title="清除选区" aria-label="清除选区" onClick={clearSelection}><X size={16} /></button></div>}
    {selection && moreAnchor && <ReadingActionsMenu root={root} anchor={moreAnchor} close={() => setMoreAnchor(null)} label="选区更多操作" actions={[
      { label: '单独讨论选区', run: () => { void deepenSelection(selection.reference).catch(e => setError((e as Error).message)); clearSelection(); } },
      { label: '收进笔记', run: () => { setCollectSource({ kind: 'excerpt', reference: selection.reference }); clearSelection(); } },
      { label: '交给 Multivac', run: () => { handover({ sourceKind: 'book', sourceBook: selection.reference, text: selection.reference.text, sourceTitle: book.title }); clearSelection(); } },
    ]} />}
    {cardOpen && <ReadingNoteCard root={root} book={book} notes={notes} edit={candidate => void editNote(candidate)} returnDiscussion={source => void returnDiscussion(source)} close={closeNoteCard} locate={r => { if (validBookReference(book, r)) locate(r.start); else setError('原位置已失效，摘录仍保留。'); }} />}
    {collectSource && <ReadingCollectCard source={collectSource} close={() => setCollectSource(null)} openNotes={onOpenNotes} />}
  </section>;
}
