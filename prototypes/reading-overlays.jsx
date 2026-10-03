import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Highlighter, MessageSquare, MoreHorizontal, Pencil, X } from 'lucide-react';
import { bookParagraphs, validReference } from './reading-state.js';
import { readingFloatingPosition } from './reading-view-state.js';

export function ReadingReference({ book, reference, onLocate, compact = false }) {
  if (!reference) return <small className="reading-unavailable">原文位置不可用；记录内容仍保留。</small>;
  const available = validReference(book, reference);
  const paragraph = bookParagraphs(book).find((item) => item.paragraphId === reference.start.paragraphId && item.chapterId === reference.start.chapterId);
  return <div className={`reading-reference ${compact ? 'compact' : ''}`}>
    <span>{reference.chapterTitle || paragraph?.chapterTitle} · {available ? `第 ${(paragraph?.paragraphIndex || 0) + 1} 段` : '原位置已失效'}{reference.pageNumber ? ` · 引用时第 ${reference.pageNumber} 页` : ''}</span>
    <details><summary>{reference.text.slice(0, compact ? 45 : 75)}{reference.text.length > (compact ? 45 : 75) ? '…' : ''}</summary><blockquote>{reference.text}</blockquote></details>
    <button type="button" className="inline-link" disabled={!available} onClick={() => onLocate(reference)}>定位原文</button>
  </div>;
}

export function ReadingSourceTag({ reference, book, onLocate }) {
  return <div className="reading-source-tag"><span>{reference?.chapterTitle || '原文引用'}{reference?.unavailable ? ' · 位置已失效' : ''}</span>
    <button type="button" className="inline-link" disabled={!validReference(book, reference)} onClick={() => onLocate(reference)}>定位原文</button>
  </div>;
}

/** 浮层测量与正文测量互不依赖；可视区缩小时移动卡片，保持正文布局。 */
function useFloatingBox(rootRef, anchor, kind, compact, mainRef) {
  const boxRef = useRef(null);
  const [style, setStyle] = useState({ visibility: 'hidden' });
  useLayoutEffect(() => {
    let frame;
    const position = () => {
      const root = rootRef.current?.getBoundingClientRect();
      const box = boxRef.current;
      if (!root?.width || !box) return;
      const visual = window.visualViewport;
      const bounds = { left: Math.max(root.left, visual?.offsetLeft || 0), right: Math.min(root.right, (visual?.offsetLeft || 0) + (visual?.width || innerWidth)), top: Math.max(root.top, visual?.offsetTop || 0), bottom: Math.min(root.bottom, (visual?.offsetTop || 0) + (visual?.height || innerHeight)) };
      const size = box.getBoundingClientRect();
      let location;
      let maxHeight = Math.max(120, bounds.bottom - bounds.top - 16);
      if (kind === 'card') {
        const main = mainRef.current?.getBoundingClientRect() || root;
        maxHeight = Math.min(440, Math.max(120, bounds.bottom - bounds.top - (compact ? 16 : 80)));
        const width = Math.min(compact ? root.width - 16 : 340, main.width - 24, bounds.right - bounds.left - 16);
        location = { left: Math.max(bounds.left - root.left + 8, Math.min(main.right, bounds.right) - root.left - width - (compact ? 8 : 12)), top: Math.max(bounds.top - root.top + 8, bounds.bottom - root.top - Math.min(size.height, maxHeight) - (compact ? 8 : 64)), width };
      } else if (kind === 'selection' && compact) {
        location = { left: bounds.left - root.left + 8, top: Math.max(bounds.top - root.top + 8, bounds.bottom - root.top - size.height - (bounds.bottom < root.bottom ? 8 : 78)), width: bounds.right - bounds.left - 16 };
      } else {
        const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
        if (!rect) return;
        location = readingFloatingPosition(rect, size, bounds);
      }
      const next = { ...location, maxHeight, visibility: 'visible' };
      setStyle((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    const observer = new ResizeObserver(schedule);
    // 恢复卡片时子组件先执行布局副作用，等待父容器 ref 完成挂载。
    frame = requestAnimationFrame(() => {
      if (!rootRef.current || !boxRef.current) return;
      observer.observe(rootRef.current); observer.observe(boxRef.current);
      if (mainRef?.current) observer.observe(mainRef.current);
      position();
    });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    position();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule); };
  }, [rootRef, anchor, kind, compact, mainRef]);
  return [boxRef, style];
}

export function ReadingPopover({ rootRef, anchor, kind, onClose, children }) {
  const [ref, style] = useFloatingBox(rootRef, anchor, 'menu', false);
  useEffect(() => {
    if (style.visibility === 'visible') ref.current.querySelector('input, button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event) => {
      if (!ref.current?.contains(event.target) && !anchor?.contains(event.target)) onClose(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [anchor, style.visibility]);
  return <div ref={ref} id={`reading-${kind}-popover`} className="reading-popover" style={style} role={kind === 'selection' ? 'menu' : 'dialog'} aria-label={kind === 'selection' ? '选区更多操作' : '正文字号'} onKeyDown={(event) => {
    if (kind !== 'selection' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }}>
    {children}
    <button type="button" className="icon-button reading-popover-close" aria-label="关闭浮层" onClick={() => onClose(true)}><X /></button>
  </div>;
}

export function ReadingSelectionToolbar({ rootRef, reference, rect, compact, onAsk, onHighlight, onNote, onMore, moreRef, onClose }) {
  const [ref, style] = useFloatingBox(rootRef, rect, 'selection', compact);
  return <div ref={ref} className="reading-selection" role="toolbar" aria-label="选区操作" style={style} onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault(); }}>
    <span title={reference.text}>「{reference.text.slice(0, 36)}」</span>
    <div>
      <button type="button" className="secondary" onClick={onAsk}><MessageSquare />问书伴</button>
      <button type="button" className="secondary" onClick={onHighlight}><Highlighter />划线</button>
      <button type="button" className="secondary" onClick={onNote}><Pencil />写笔记</button>
      <button ref={moreRef} type="button" className="secondary" aria-haspopup="menu" aria-expanded={onMore.open} aria-controls="reading-selection-popover" onClick={onMore.toggle}><MoreHorizontal />更多</button>
      <button type="button" className="icon-button" aria-label="清除选区" onClick={onClose}><X /></button>
    </div>
  </div>;
}

export function ReadingNoteCard({ rootRef, mainRef, compact, draft, pending, relatedNotes, persistenceError, onChange, onClose, onSave, onDiscard, onContinue, onSaveAndContinue, onChoose, onLocate, onReturnDiscussion }) {
  const [ref, style] = useFloatingBox(rootRef, null, 'card', compact, mainRef);
  const input = useRef(null);
  const revealInput = () => {
    if (document.activeElement !== input.current) return;
    const body = ref.current?.querySelector('.reading-note-card-body');
    if (!body) return;
    const field = input.current.getBoundingClientRect();
    const bounds = body.getBoundingClientRect();
    if (field.bottom > bounds.bottom - 8) body.scrollTop += field.bottom - bounds.bottom + 8;
    else if (field.top < bounds.top + 8) body.scrollTop -= bounds.top - field.top + 8;
  };
  useEffect(() => { if (style.visibility === 'visible') { input.current?.focus({ preventScroll: true }); revealInput(); } }, [draft.id, draft.reference, style.visibility]);
  useLayoutEffect(revealInput, [style.maxHeight, style.top, style.width]);
  return <section ref={ref} className="reading-note-card" style={style} aria-labelledby="reading-note-card-title">
    <header><h2 id="reading-note-card-title">{pending ? '继续现有草稿' : draft.id ? '编辑阅读笔记' : '记录想法'}</h2><button type="button" className="icon-button" title="收起，保留草稿" aria-label="收起笔记，保留草稿" onClick={onClose}><X /></button></header>
    <div className="reading-note-card-body">
      {pending && <div className="reading-draft-conflict"><p>已有未保存草稿，已保留原引用。请先处理现有草稿。</p><button type="button" className="inline-link" onClick={onContinue}>继续现有草稿</button><button type="button" className="inline-link" disabled={!draft.body.trim()} onClick={onSaveAndContinue}>保存现有草稿，记录新引用</button></div>}
      {relatedNotes.length > 1 && <label className="reading-field">此处笔记（{relatedNotes.length}）<select aria-label="选择此处笔记" value={draft.id || ''} onChange={(event) => onChoose(relatedNotes.find((note) => note.id === event.target.value))}>{!draft.id && <option value="">新笔记</option>}{relatedNotes.map((note) => <option key={note.id} value={note.id}>{note.body.slice(0, 24)}</option>)}</select></label>}
      <div className="reading-card-source">
        <q title={draft.reference?.text}>{draft.reference?.text || '原文位置不可用，仍可继续记录。'}</q>
        {draft.origin === 'companion' && <small>来自书伴回答</small>}
      </div>
      <label className="reading-note-input"><span className="sr-only">笔记内容</span><textarea ref={input} rows={4} value={draft.body} onChange={(event) => onChange(event.target.value)} placeholder="写下你的想法…" /></label>
    </div>
    <footer>
      <small className="reading-draft-status" role="status">{persistenceError || '草稿已保留'}</small>
      <details className="reading-note-menu reading-card-menu"><summary title="更多笔记操作" aria-label="更多笔记操作"><MoreHorizontal /></summary><div>
        {draft.reference && <button type="button" disabled={draft.reference.unavailable} onClick={(event) => { onLocate(draft.reference); event.currentTarget.closest('details').open = false; }}>定位原文</button>}
        {(draft.origin === 'companion' || pending?.origin === 'companion') && <button type="button" onClick={onReturnDiscussion}>返回讨论</button>}
        <button type="button" onClick={onDiscard}>{pending ? '丢弃现有草稿，记录新引用' : '丢弃草稿'}</button>
      </div></details>
      <button type="button" className="primary" disabled={!draft.body.trim()} onClick={onSave}>保存</button>
    </footer>
  </section>;
}
