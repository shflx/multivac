import { positionRank, validBookReference, type ReadingBook } from './reading-book.js';
import { useReadingTextPreview } from './use-reading-text-preview.js';
import { useEffect, useRef, useState } from 'react';
import { Bookmark, Highlighter, Trash2, ArrowLeft, Save, Pencil, X } from 'lucide-react';
import { bookParagraphs, type AnnotationCommand, type Book, type BookReference, type ReadingAnnotation, type ReadingNote } from '@multivac/contracts';

function annotationParts(text: string, ranges: { start: number; end: number; noteId?: string; located?: boolean }[]) {
  const cuts = [...new Set([0, text.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((start, i) => {
    const active = ranges.filter(r => start >= r.start && start < r.end);
    return { start, text: text.slice(start, cuts[i + 1]), marked: active.some(r => !r.noteId && !r.located), noteIds: active.flatMap(r => r.noteId ? [r.noteId] : []), located: active.some(r => r.located) };
  });
}
export function highlightedParagraphs(book: Book, records: ReadingAnnotation[], notes: ReadingNote[] = [], located: BookReference | null = null) {
  const paragraphs = bookParagraphs(book);
  const ranges = new Map<string, { start: number; end: number; noteId?: string; located?: boolean }[]>();
  const annotations: { reference: BookReference; noteId?: string; located?: boolean }[] = [...records.filter(r => r.kind === 'highlight').map(r => ({ reference: r.reference })), ...notes.flatMap(n => n.reference ? [{ reference: n.reference, noteId: n.id }] : []), ...(located ? [{ reference: located, located: true }] : [])];
  for (const record of annotations) {
    if (!validBookReference(book, record.reference)) continue;
    const { start, end } = record.reference;
    const a = positionRank(book, start), b = positionRank(book, end);
    for (const p of paragraphs) {
      const rank = positionRank(book, { chapterId: p.chapterId, paragraphId: p.id, offset: 0 });
      if (rank >= b || rank + p.text.length <= a) continue;
      const segment = { start: Math.max(0, a - rank), end: Math.min(p.text.length, b - rank), ...(record.noteId ? { noteId: record.noteId } : {}), ...(record.located ? { located: true } : {}) };
      if (segment.end > segment.start) ranges.set(p.id, [...(ranges.get(p.id) ?? []), segment]);
    }
  }
  return new Map(paragraphs.map(p => [p.id, annotationParts(p.text, ranges.get(p.id) ?? [])]));
}

function AnnotationItem({ book, record, disabled, execute, locate }: { book: ReadingBook; record: ReadingAnnotation; disabled: boolean; execute: (c: AnnotationCommand) => void; locate: (r: ReadingAnnotation['reference']) => void }) {
  const [remark, setRemark] = useState(record.remark);
  const [editing, setEditing] = useState(false);
  const previous = useRef(record.remark);
  useEffect(() => { setRemark(current => current === previous.current ? record.remark : current); previous.current = record.remark; }, [record.remark]);
  const available = validBookReference(book, record.reference);
  return <article className="reading-record"><button className="reading-record-location" disabled={!available} onClick={() => locate(record.reference)}><blockquote>{record.reference.text}</blockquote><small>{available ? book.chapters.find(c => c.id === record.reference.start.chapterId)?.title : '原位置已失效 · 摘录已保留'}</small>{record.remark && <p>{record.remark}</p>}</button>
    <div className="reading-record-actions"><button className="reading-command" title="定位原文" aria-label="定位原文" disabled={!available} onClick={() => locate(record.reference)}><ArrowLeft size={16} /></button><button className="reading-command" title={record.kind === 'bookmark' ? '删除书签' : '移除划线'} aria-label={record.kind === 'bookmark' ? '删除书签' : '移除划线'} disabled={disabled} onClick={() => execute({ commandId: crypto.randomUUID(), id: record.id, expectedRevision: record.revision, kind: record.kind, action: 'delete' })}><Trash2 size={16} /></button></div>
    {record.kind === 'bookmark' && <button className="reading-tool reading-edit-remark" aria-expanded={editing} onClick={() => setEditing(v => !v)}><Pencil size={13} />{editing ? '收起备注' : '编辑备注'}</button>}
    {record.kind === 'bookmark' && editing && <form onSubmit={event => { event.preventDefault(); execute({ commandId: crypto.randomUUID(), id: record.id, expectedRevision: record.revision, kind: record.kind, action: 'save', reference: record.reference, remark }); }}><label>书签备注<input maxLength={2000} value={remark} onChange={event => setRemark(event.target.value)} /></label><button className="reading-icon" title="保存备注" aria-label="保存备注" disabled={disabled || remark === record.remark || !available}><Save size={16} /></button></form>}
  </article>;
}
function HighlightItem({ book, record, pageReference, disabled, noteDisabled, execute, locate, onNote }: {
  book: ReadingBook; record: ReadingAnnotation; pageReference: BookReference | null; disabled: boolean; noteDisabled: boolean;
  execute: (c: AnnotationCommand) => void; locate: (r: BookReference) => void; onNote?: ((reference: BookReference) => void) | undefined;
}) {
  const { id, element, expanded, truncated, toggle } = useReadingTextPreview(record.reference.text, 4);
  const available = validBookReference(book, record.reference);
  const chapter = (book.index?.chapters ?? book.chapters).find(c => c.id === record.reference.start.chapterId);
  const onPage = available && pageReference && positionRank(book, record.reference.start) < positionRank(book, pageReference.end) && positionRank(book, record.reference.end) > positionRank(book, pageReference.start);
  return <article className="reading-record reading-highlight-record">
    <div className="reading-note-meta reading-highlight-meta">
      <div className="reading-highlight-location"><span>{chapter?.title || '原文章节不可用'}</span>{onPage && <small>· 本页</small>}</div>
      <button className="reading-icon reading-highlight-remove" title="移除划线" aria-label="移除划线" disabled={disabled} onClick={() => execute({ commandId: crypto.randomUUID(), id: record.id, expectedRevision: record.revision, kind: 'highlight', action: 'delete' })}><Trash2 size={14} aria-hidden="true" /></button>
    </div>
    <p id={id} ref={element} className={`reading-highlight-excerpt${expanded ? '' : ' reading-highlight-preview'}`}>{record.reference.text}</p>
    {!available && <small className="reading-note-unavailable">原文位置已失效，摘录已保留</small>}
    <div className="reading-record-actions reading-note-actions">
      <div className="reading-note-actions-local">{truncated && <button className="reading-tool" aria-expanded={expanded} aria-controls={id} onClick={toggle}>{expanded ? '收起摘录' : '展开摘录'}</button>}</div>
      <div className="reading-note-actions-navigation">
        <button className="reading-tool" disabled={!available} onClick={() => locate(record.reference)}>定位原文</button>
        {onNote && <button className="reading-tool" disabled={!available || noteDisabled} onClick={() => onNote(record.reference)}>写笔记</button>}
      </div>
    </div>
  </article>;
}
export function ReadingAnnotations({ book, records, disabled, execute, locate, mode, onNote, pageReference = null, noteDisabled = false, removedHighlight = null, onUndo, onDismissUndo }: {
  book: ReadingBook; records: ReadingAnnotation[]; disabled: boolean; execute: (c: AnnotationCommand) => void; locate: (r: BookReference) => void;
  mode?: 'bookmark' | 'highlight'; onNote?: ((reference: BookReference) => void) | undefined; pageReference?: BookReference | null;
  noteDisabled?: boolean; removedHighlight?: ReadingAnnotation | null; onUndo?: () => void; onDismissUndo?: () => void;
}) {
  const [tab, setTab] = useState<'bookmark' | 'highlight'>('bookmark');
  const current = mode ?? tab;
  const filtered = records.filter(r => r.kind === current);
  // 全书索引提供原文顺序；失效来源置后，保留摘录与独立提示。
  const sorted = current === 'highlight' ? filtered.map(record => ({ record, rank: validBookReference(book, record.reference) ? positionRank(book, record.reference.start) : Infinity }))
    .sort((a, b) => a.rank - b.rank || a.record.id.localeCompare(b.record.id)).map(item => item.record) : filtered;
  return <aside className="reading-record-panel" aria-label={mode === 'bookmark' ? '书签' : mode === 'highlight' ? '划线' : '阅读记录'}>{mode && <header><strong>{mode === 'bookmark' ? '书签' : '划线'}</strong></header>}<div hidden={Boolean(mode)} className="reading-record-tabs" role="tablist" aria-label="阅读记录类型"><button role="tab" aria-selected={tab === 'bookmark'} onClick={() => setTab('bookmark')}><Bookmark size={16} />书签</button><button role="tab" aria-selected={tab === 'highlight'} onClick={() => setTab('highlight')}><Highlighter size={16} />划线</button></div>
    {current === 'highlight' && removedHighlight && onUndo && <div className="reading-highlight-undo"><span role="status">已移除划线</span><button className="reading-tool" disabled={disabled} onClick={onUndo}>撤销移除划线</button>{onDismissUndo && <button className="reading-icon" title="关闭撤销提示" aria-label="关闭撤销提示" onClick={onDismissUndo}><X size={14} aria-hidden="true" /></button>}</div>}
    {!filtered.length && <p>{current === 'bookmark' ? '暂无书签' : '在正文中选中文字，即可划线'}</p>}
    {sorted.map(r => current === 'highlight'
      ? <HighlightItem key={r.id} book={book} record={r} pageReference={pageReference} disabled={disabled} noteDisabled={noteDisabled} execute={execute} locate={locate} onNote={onNote} />
      : <AnnotationItem key={r.id} book={book} record={r} disabled={disabled} execute={execute} locate={locate} />)}
  </aside>;
}
