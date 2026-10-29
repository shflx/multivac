import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NoteSummary } from '@multivac/contracts';

const PAGE_SIZE = 100;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

const NoteListRow = memo(function NoteListRow({ id, title, updatedAt, selected, onChoose, onDeleteRoot }: {
  id: string; title: string; updatedAt: string; selected: boolean;
  onChoose(id: string): void; onDeleteRoot(root: HTMLSpanElement | null): void;
}) {
  const date = useMemo(() => {
    if (!updatedAt) return { short: '已加密', full: '输入共用密码后查看' };
    const value = new Date(updatedAt);
    const full = value.toLocaleString();
    return { short: Number.isNaN(value.getTime()) ? full : dateFormat.format(value), full };
  }, [updatedAt]);
  return <div className="notes-library-item" data-selected={selected}>
    <button type="button" className="note-list-open" aria-current={selected ? 'true' : undefined} title={title || '未命名笔记'} onClick={() => onChoose(id)}>
      <span className="notes-library-copy"><strong>{title || '未命名笔记'}</strong><time dateTime={updatedAt} title={date.full}>{date.short}</time></span>
    </button>
    {selected && <span className="note-list-actions" ref={onDeleteRoot} />}
  </div>;
});

/** 全量匹配仍由摘要决定；原生分页按钮让键盘也能访问全部结果。 */
export const NotesList = memo(function NotesList({ notes, selected, onChoose, onDeleteRoot }: {
  notes: NoteSummary[]; selected: string | null;
  onChoose(id: string): void; onDeleteRoot(root: HTMLSpanElement | null): void;
}) {
  const [page, setPage] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const focusPage = useRef(false);
  const pages = Math.max(1, Math.ceil(notes.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    const index = notes.findIndex(note => note.id === selected);
    setPage(index < 0 ? 0 : Math.floor(index / PAGE_SIZE));
  }, [notes, selected]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !focusPage.current) return;
    focusPage.current = false;
    element.parentElement?.scrollTo({ top: 0 });
    element.querySelector<HTMLButtonElement>('.note-list-open')?.focus({ preventScroll: true });
  }, [current]);
  function turn(next: number) { focusPage.current = true; setPage(next); }
  return <div ref={root}>
    {notes.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(note => <NoteListRow key={note.id} id={note.id} title={note.title} updatedAt={note.updatedAt} selected={selected === note.id} onChoose={onChoose} onDeleteRoot={onDeleteRoot} />)}
    {pages > 1 && <nav className="notes-library-pagination" aria-label="笔记列表分页">
      <button type="button" aria-label="上一页笔记" disabled={current === 0} onClick={() => turn(current - 1)}>上一页</button>
      <span role="status">{current + 1} / {pages}</span>
      <button type="button" aria-label="下一页笔记" disabled={current === pages - 1} onClick={() => turn(current + 1)}>下一页</button>
    </nav>}
  </div>;
});
