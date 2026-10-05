import { positionRank, validBookReference, validBookLocation, type ReadingBook } from './reading-book.js';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, Pencil, Quote, Save, Trash2, X } from 'lucide-react';
import { bookLocation, readingNoteLocation, hasUnsavedReadingNote, type BookReference, type ReadingNoteDraft, type ReadingNote } from '@multivac/contracts';
import type { useReadingNotes } from './use-reading-notes.js';
import { useReadingFloating } from './reading-floating.js';

import { useConfirm } from '../../components/confirm-card.js';

export function noteDraft(note: ReadingNoteDraft): ReadingNoteDraft {
  return { id: note.id, body: note.body, location: readingNoteLocation(note), ...(note.reference ? { reference: note.reference } : {}), origin: note.origin, ...(note.discussion ? { discussion: note.discussion } : {}) };
}
function noteLocatable(book: ReadingBook, note: ReadingNoteDraft): boolean {
  return note.reference ? validBookReference(book, note.reference) : validBookLocation(book, readingNoteLocation(note));
}
interface ReadingNoteItemProps {
  book: ReadingBook;
  note: ReadingNote;
  pageReference: BookReference | null;
  locate: (note: ReadingNoteDraft) => void;
  edit: (draft: ReadingNoteDraft) => void;
}
function ReadingNoteItem({ book, note, pageReference, locate, edit }: ReadingNoteItemProps) {
  const body = note.body;
  const bodyId = useId();
  const element = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const node = element.current!;
    const measure = () => {
      // 按实际排版判断三行是否足够；展开后也保留收起入口。
      const overflowing = node.scrollHeight > Math.ceil(parseFloat(getComputedStyle(node).lineHeight) * 3) + 1;
      setTruncated(overflowing);
      if (!overflowing) setExpanded(false);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    document.fonts.addEventListener('loadingdone', measure);
    measure();
    return () => { observer.disconnect(); document.fonts.removeEventListener('loadingdone', measure); };
  }, [body]);
  const location = readingNoteLocation(note);
  const locatable = noteLocatable(book, note);
  const chapter = (book.index?.chapters ?? book.chapters).find(c => c.id === location.position.chapterId);
  const onPage = pageReference && validBookLocation(book, location) && positionRank(book, location.position) >= positionRank(book, pageReference.start) && positionRank(book, location.position) < positionRank(book, pageReference.end);
  return <article className="reading-record">
    <div className="reading-note-meta"><span>{chapter?.title || '阅读笔记'}</span>{!note.reference && <small>· 阅读时记下</small>}{onPage && <small>· 本页</small>}{note.origin === 'companion' && note.discussion && <small>· 来自书伴</small>}</div>
    <p id={bodyId} ref={element} className={expanded ? 'reading-note-body' : 'reading-note-body reading-note-preview'}>{body}</p>
    {note.reference && <blockquote className="reading-note-excerpt">引用：{note.reference.text}</blockquote>}
    {!locatable && <small className="reading-note-unavailable">{note.reference ? '原文暂不可定位，摘录已保留' : '原文位置暂不可定位，笔记已保留'}</small>}
    <div className="reading-record-actions reading-note-actions">
      <div className="reading-note-actions-local">
        {truncated && <button className="reading-tool" aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(value => !value)}>{expanded ? '收起笔记' : '展开笔记'}</button>}
      </div>
      <div className="reading-note-actions-navigation">
        <button className="reading-tool" disabled={!locatable} onClick={() => locate(note)}>定位原文</button>
        <button className="reading-tool" aria-label="编辑笔记" onClick={() => edit(noteDraft(note))}><Pencil size={14} />编辑</button>
      </div>
    </div>
  </article>;
}
export function ReadingNotesPanel({ book, pageReference, notes, locate, edit }: { book: ReadingBook; pageReference: BookReference | null; notes: ReturnType<typeof useReadingNotes>; locate: (note: ReadingNoteDraft) => void; edit: (draft: ReadingNoteDraft) => void }) {
  const rank = (note: ReadingNoteDraft) => validBookLocation(book, readingNoteLocation(note)) ? positionRank(book, readingNoteLocation(note).position) : Infinity;
  const sorted = [...notes.state.notes].sort((a, b) => rank(a) - rank(b));
  return <aside className="reading-record-panel reading-notes-list" aria-label="阅读笔记">
    {notes.draft && <button className="reading-resume-note reading-tool" onClick={() => edit(notes.draft!)}><i className="reading-draft-dot" />继续草稿<Pencil size={13} /></button>}
    {notes.loading && <p role="status">正在加载阅读笔记…</p>}
    {notes.loadError && <div role="alert">{notes.loadError}<button className="reading-tool" onClick={() => void notes.refresh()}>重试加载笔记</button></div>}
    {notes.loaded && !notes.loading && !notes.loadError && !notes.state.notes.length && <div className="reading-notes-empty"><Pencil size={25} /><strong>暂无阅读笔记</strong><button className="reading-tool" disabled={!pageReference} onClick={() => pageReference && edit({ id: crypto.randomUUID(), body: '', location: bookLocation(pageReference), origin: 'user' })}>记下第一条笔记</button></div>}
    {sorted.map(note => <ReadingNoteItem key={note.id} book={book} note={note} pageReference={pageReference} locate={locate} edit={edit} />)}
  </aside>;
}
export function ReadingNoteCard({ root, book, pageReference, notes, edit, returnDiscussion, close, locate, handover }: { root: RefObject<HTMLElement | null>; book: ReadingBook; pageReference: BookReference | null; notes: ReturnType<typeof useReadingNotes>; edit: (draft: ReadingNoteDraft) => void; returnDiscussion: (source: NonNullable<ReadingNoteDraft['discussion']>) => void; close: () => void; locate: (note: ReadingNoteDraft) => void; handover: (note: ReadingNote) => void }) {
  const confirm = useConfirm();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const floating = useReadingFloating(root, null, true);
  useEffect(() => { textarea.current?.focus(); }, [notes.draft?.id]);
  useLayoutEffect(() => { if (document.activeElement === textarea.current) textarea.current?.scrollIntoView({ block: 'nearest' }); }, [floating.style.maxHeight, floating.style.top]);
  if (!notes.draft) return null;
  const saved = notes.state.notes.find(note => note.id === notes.draft!.id);
  const unsaved = hasUnsavedReadingNote(notes.state, notes.draft);
  async function deleteSaved() {
    if (!saved) return;
    if (await confirm({ title: '删除已保存笔记？', description: '这条已保存笔记及其未保存修改将一并删除，无法恢复。原文和其他笔记不受影响。', confirmLabel: '删除笔记', tone: 'danger' })) {
      if (await notes.deleteNote(saved.id, saved.revision)) close();
    }
  }
  const location = readingNoteLocation(notes.draft);
  const chapter = (book.index?.chapters ?? book.chapters).find(c => c.id === location.position.chapterId);
  const locatable = noteLocatable(book, notes.draft);
  const related = notes.state.notes.filter(n => {
    const position = readingNoteLocation(n).position;
    return position.chapterId === location.position.chapterId && position.paragraphId === location.position.paragraphId;
  });
  return <div {...floating} className="reading-note-card" role="dialog" aria-label="阅读笔记草稿" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}><header><strong>{notes.target ? '处理未保存草稿' : saved ? '编辑阅读笔记' : '阅读笔记草稿'}</strong><button className="reading-command" title="收起笔记，保留草稿" aria-label="收起笔记，保留草稿" onClick={close}><X size={16} /></button></header>
    {notes.target && <div className="reading-draft-conflict"><p>已有未保存草稿。</p><button disabled={notes.busy} onClick={() => void notes.save(notes.target)}>保存并继续</button><button disabled={notes.busy} onClick={() => void notes.discard(notes.target)}>放弃并继续</button><button onClick={notes.continueDraft}>继续原草稿</button></div>}
    {notes.draft.discussion && <button className="reading-command" onClick={() => returnDiscussion(notes.draft!.discussion!)}><ArrowLeft size={16} />返回来源讨论</button>}
    {related.length > 1 && <label>此处笔记<select aria-label="选择此处笔记" value={notes.draft.id} onChange={event => { const note = related.find(n => n.id === event.target.value); if (note) edit(noteDraft(note)); }}><option value={notes.draft.id}>当前草稿</option>{related.filter(n => n.id !== notes.draft!.id).map(n => <option value={n.id} key={n.id}>{n.body.slice(0, 24)}</option>)}</select></label>}
    <div className="reading-note-meta"><span>{chapter?.title || '阅读笔记'}</span>{!notes.draft.reference && <small>· 阅读时记下</small>}</div>
    {notes.draft.reference && <div className="reading-note-quote"><blockquote>引用：{notes.draft.reference.text}</blockquote><button className="reading-tool" aria-label="移除引用" disabled={notes.locked} onClick={() => { const { reference: _reference, ...draft } = notes.draft!; notes.change({ ...draft, location }); }}><X size={14} />移除引用</button></div>}
    {!locatable && <small>{notes.draft.reference ? '原文暂不可定位，摘录已保留' : '原文位置暂不可定位，笔记已保留'}</small>}<textarea ref={textarea} aria-label="笔记内容" rows={6} maxLength={12000} disabled={notes.locked} value={notes.draft.body} onChange={event => notes.change({ ...notes.draft!, body: event.target.value })} />
    {notes.error && <div role="alert">{notes.error}<details><summary>服务端草稿</summary><p>{notes.state.draft?.body ?? '无草稿'}</p></details>{notes.pending && <button disabled={notes.busy} onClick={notes.retry}>重试原命令</button>}<button disabled={notes.busy} onClick={() => void notes.resolveLocal()}>核对后保留当前草稿</button></div>}
    <footer><small role="status">{notes.busy ? '正在保存' : JSON.stringify(notes.draft) === JSON.stringify(notes.state.draft) ? '草稿已保留' : '草稿待保存'}</small><button className="reading-command" title="定位草稿原文" aria-label="定位草稿原文" disabled={!locatable} onClick={() => locate(notes.draft!)}><ArrowLeft size={16} /></button><button className="reading-command" disabled={notes.busy || Boolean(notes.pending) || !notes.draft.body.trim()} onClick={() => void notes.save()}><Save size={16} />保存笔记</button>{!notes.draft.reference && <button className="reading-tool" disabled={notes.locked || !pageReference} onClick={() => pageReference && notes.change({ ...notes.draft!, reference: pageReference })}><Quote size={14} />引用当前页</button>}<button className="reading-command" disabled={notes.busy || Boolean(notes.pending)} onClick={() => void notes.discard()}><X size={16} />{saved ? '放弃未保存修改' : '放弃未保存草稿'}</button></footer>
    {saved && !notes.target && <div className="reading-note-saved-actions"><button className="reading-command" disabled={notes.busy || Boolean(notes.pending) || unsaved} title={unsaved ? '请先保存修改' : undefined} onClick={() => handover(saved)}>交给 Multivac</button><button className="reading-command reading-note-delete" disabled={notes.busy || Boolean(notes.pending)} onClick={() => void deleteSaved()}><Trash2 size={16} />删除已保存笔记</button></div>}
  </div>;
}
