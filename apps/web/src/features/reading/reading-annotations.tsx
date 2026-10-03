import { useState } from 'react';
import { Bookmark, Highlighter, Trash2, ArrowLeft, Save } from 'lucide-react';
import { bookParagraphs, validBookReference, type AnnotationCommand, type Book, type ReadingAnnotation } from '@multivac/contracts';

function annotationParts(text: string, ranges: { start: number; end: number }[]) {
  const cuts = [...new Set([0, text.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b);
  return cuts.slice(0, -1).map((start, i) => ({ start, text: text.slice(start, cuts[i + 1]), marked: ranges.some(r => start >= r.start && start < r.end) }));
}
export function highlightedParagraphs(book: Book, records: ReadingAnnotation[]) {
  const paragraphs = bookParagraphs(book);
  const indices = new Map(paragraphs.map((p, i) => [p.id, i]));
  const ranges = new Map<string, { start: number; end: number }[]>();
  for (const record of records) {
    if (record.kind !== 'highlight' || !validBookReference(book, record.reference)) continue;
    const { start, end } = record.reference;
    const a = indices.get(start.paragraphId)!, b = indices.get(end.paragraphId)!;
    for (let i = a; i <= b; i++) {
      const p = paragraphs[i]!;
      const segment = { start: i === a ? start.offset : 0, end: i === b ? end.offset : p.text.length };
      if (segment.end > segment.start) ranges.set(p.id, [...(ranges.get(p.id) ?? []), segment]);
    }
  }
  return new Map(paragraphs.map(p => [p.id, annotationParts(p.text, ranges.get(p.id) ?? [])]));
}

function AnnotationItem({ book, record, disabled, execute, locate }: { book: Book; record: ReadingAnnotation; disabled: boolean; execute: (c: AnnotationCommand) => void; locate: (r: ReadingAnnotation['reference']) => void }) {
  const [remark, setRemark] = useState(record.remark);
  const available = validBookReference(book, record.reference);
  return <article className="reading-record"><blockquote>{record.reference.text}</blockquote><small>{available ? book.chapters.find(c => c.id === record.reference.start.chapterId)?.title : '原位置已失效 · 摘录已保留'}</small>
    <div className="reading-record-actions"><button className="reading-command" title="定位原文" aria-label="定位原文" disabled={!available} onClick={() => locate(record.reference)}><ArrowLeft size={16} /></button><button className="reading-command" title={record.kind === 'bookmark' ? '删除书签' : '移除划线'} aria-label={record.kind === 'bookmark' ? '删除书签' : '移除划线'} disabled={disabled} onClick={() => execute({ commandId: crypto.randomUUID(), id: record.id, expectedRevision: record.revision, kind: record.kind, action: 'delete' })}><Trash2 size={16} /></button></div>
    {record.kind === 'bookmark' && <form onSubmit={event => { event.preventDefault(); execute({ commandId: crypto.randomUUID(), id: record.id, expectedRevision: record.revision, kind: record.kind, action: 'save', reference: record.reference, remark }); }}><label>书签备注<input maxLength={2000} value={remark} onChange={event => setRemark(event.target.value)} /></label><button className="reading-command" title="保存备注" aria-label="保存备注" disabled={disabled || remark === record.remark || !available}><Save size={16} /></button></form>}
  </article>;
}
export function ReadingAnnotations({ book, records, disabled, execute, locate }: { book: Book; records: ReadingAnnotation[]; disabled: boolean; execute: (c: AnnotationCommand) => void; locate: (r: ReadingAnnotation['reference']) => void }) {
  const [tab, setTab] = useState<'bookmark' | 'highlight'>('bookmark');
  return <aside className="reading-record-panel" aria-label="阅读记录"><div className="reading-record-tabs" role="tablist" aria-label="阅读记录类型"><button role="tab" aria-selected={tab === 'bookmark'} onClick={() => setTab('bookmark')}><Bookmark size={16} />书签</button><button role="tab" aria-selected={tab === 'highlight'} onClick={() => setTab('highlight')}><Highlighter size={16} />划线</button></div>
    {!records.some(r => r.kind === tab) && <p>{tab === 'bookmark' ? '暂无书签' : '暂无划线'}</p>}
    {records.filter(r => r.kind === tab).map(r => <AnnotationItem key={`${r.id}:${r.revision}`} book={book} record={r} disabled={disabled} execute={execute} locate={locate} />)}
  </aside>;
}
