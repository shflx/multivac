import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Pencil, Save, Trash2, X } from 'lucide-react';
import { validBookReference, type Book, type BookReference, type ReadingNoteDraft } from '@multivac/contracts';
import type { useReadingNotes } from './use-reading-notes.js';

export function noteDraft(note: ReadingNoteDraft): ReadingNoteDraft {
  return { id: note.id, body: note.body, reference: note.reference, origin: note.origin, ...(note.discussion ? { discussion: note.discussion } : {}) };
}
export function ReadingNotesPanel({ book, notes, locate, edit }: { book: Book; notes: ReturnType<typeof useReadingNotes>; locate: (r: BookReference) => void; edit: (draft: ReadingNoteDraft) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return <aside className="reading-record-panel" aria-label="阅读笔记"><header><strong>阅读笔记 · {notes.state.notes.length}</strong></header>{notes.draft && <button className="reading-command" onClick={() => edit(notes.draft!)}><Pencil size={16} />继续草稿</button>}
    {!notes.state.notes.length && <p>暂无阅读笔记</p>}
    {notes.state.notes.map(note => <article key={note.id} className="reading-record"><blockquote>{note.reference.text}</blockquote><p className={expanded.has(note.id) ? '' : 'reading-note-preview'}>{note.body}</p><small>{note.origin === 'companion' ? '来自书伴' : '我的笔记'}{!validBookReference(book, note.reference) && ' · 原位置已失效'}</small><div className="reading-record-actions"><button onClick={() => setExpanded(s => { const next = new Set(s); if (next.has(note.id)) next.delete(note.id); else next.add(note.id); return next; })}>{expanded.has(note.id) ? '收起' : '展开'}</button><button className="reading-command" title="定位笔记原文" aria-label="定位笔记原文" disabled={!validBookReference(book, note.reference)} onClick={() => locate(note.reference)}><ArrowLeft size={16} /></button><button className="reading-command" title="编辑笔记" aria-label="编辑笔记" onClick={() => edit(noteDraft(note))}><Pencil size={16} /></button><button className="reading-command" title="删除笔记" aria-label="删除笔记" disabled={notes.busy || Boolean(notes.pending)} onClick={() => void notes.deleteNote(note.id)}><Trash2 size={16} /></button></div></article>)}
  </aside>;
}
export function ReadingNoteCard({ book, notes, edit, close, locate }: { book: Book; notes: ReturnType<typeof useReadingNotes>; edit: (draft: ReadingNoteDraft) => void; close: () => void; locate: (r: BookReference) => void }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { textarea.current?.focus(); }, [notes.draft?.id]);
  if (!notes.draft) return null;
  const related = notes.state.notes.filter(n => n.reference.start.paragraphId === notes.draft!.reference.start.paragraphId);
  return <section className="reading-note-card" aria-label="阅读笔记草稿" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}><header><strong>{notes.target ? '处理未保存草稿' : '阅读笔记草稿'}</strong><button className="reading-command" title="收起笔记，保留草稿" aria-label="收起笔记，保留草稿" onClick={close}><X size={16} /></button></header>
    {notes.target && <div className="reading-draft-conflict"><p>已有未保存草稿。</p><button disabled={notes.busy} onClick={() => void notes.save(notes.target)}>保存并继续</button><button disabled={notes.busy} onClick={() => void notes.discard(notes.target)}>放弃并继续</button><button onClick={notes.continueDraft}>继续原草稿</button></div>}
    {related.length > 1 && <label>此处笔记<select aria-label="选择此处笔记" value={notes.draft.id} onChange={event => { const note = related.find(n => n.id === event.target.value); if (note) edit(noteDraft(note)); }}><option value={notes.draft.id}>当前草稿</option>{related.filter(n => n.id !== notes.draft!.id).map(n => <option value={n.id} key={n.id}>{n.body.slice(0, 24)}</option>)}</select></label>}
    <blockquote>{notes.draft.reference.text}</blockquote>{!validBookReference(book, notes.draft.reference) && <small>原位置已失效 · 摘录已保留</small>}<textarea ref={textarea} aria-label="笔记内容" rows={6} maxLength={12000} disabled={notes.locked} value={notes.draft.body} onChange={event => notes.change({ ...notes.draft!, body: event.target.value })} />
    {notes.error && <div role="alert">{notes.error}<details><summary>服务端草稿</summary><p>{notes.state.draft?.body ?? '无草稿'}</p></details>{notes.pending && <button disabled={notes.busy} onClick={notes.retry}>重试原命令</button>}<button disabled={notes.busy} onClick={() => void notes.resolveLocal()}>核对后保留当前草稿</button></div>}
    <footer><small role="status">{notes.busy ? '正在保存' : JSON.stringify(notes.draft) === JSON.stringify(notes.state.draft) ? '草稿已保留' : '草稿待保存'}</small><button className="reading-command" title="定位草稿原文" aria-label="定位草稿原文" disabled={!validBookReference(book, notes.draft.reference)} onClick={() => locate(notes.draft!.reference)}><ArrowLeft size={16} /></button><button className="reading-command" disabled={notes.busy || Boolean(notes.pending) || !notes.draft.body.trim()} onClick={() => void notes.save()}><Save size={16} />保存笔记</button><button className="reading-command" title="放弃草稿" aria-label="放弃草稿" disabled={notes.busy || Boolean(notes.pending)} onClick={() => void notes.discard()}><Trash2 size={16} /></button></footer>
  </section>;
}
