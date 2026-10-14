import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import type { NoteSelection } from '@multivac/contracts';

/** 复用正文的排版测量层定位选区，不插入正文节点或改变 textarea 的原文与偏移。 */
export function useNoteSelectionToolbar({ editor, mirror, toolbar, selection, onDismiss }: {
  editor: RefObject<HTMLTextAreaElement | null>;
  mirror: RefObject<HTMLDivElement | null>;
  toolbar: HTMLDivElement | null;
  selection: NoteSelection | null;
  onDismiss(): void;
}) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const finish = () => setDragging(false);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
    window.addEventListener('blur', finish);
    return () => { window.removeEventListener('pointerup', finish, true); window.removeEventListener('pointercancel', finish, true); window.removeEventListener('blur', finish); };
  }, [dragging]);

  useLayoutEffect(() => {
    if (!toolbar) return;
    if (!selection || dragging) { toolbar.hidden = true; return; }
    const input = editor.current, measure = mirror.current;
    if (!input || !measure) return;
    function position() {
      if (!toolbar || !input || !measure || !selection) return;
      const field = input.getBoundingClientRect();
      const text = measure.firstChild;
      if (!field.width || text?.nodeType !== Node.TEXT_NODE || selection.end > (text.textContent?.length ?? 0)) { toolbar.hidden = true; return; }
      const range = document.createRange();
      range.setStart(text, selection.start); range.setEnd(text, selection.end);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      const anchor = input.selectionDirection === 'backward' ? rects[0] : rects.at(-1);
      const detail = input.closest<HTMLElement>('.notes-detail');
      const paper = input.closest<HTMLElement>('.note-document-scroll');
      if (!anchor || !detail || !paper) { toolbar.hidden = true; return; }
      const stacked = getComputedStyle(paper).overflowY === 'visible';
      const viewport = (stacked ? detail : paper).getBoundingClientRect();
      const commands = detail.querySelector('.note-editor-toolbar')?.getBoundingClientRect();
      const top = Math.max(8, viewport.top, commands?.bottom ?? 0);
      const bottom = Math.min(window.innerHeight - 8, viewport.bottom, field.bottom);
      const left = Math.max(8, viewport.left, field.left);
      const right = Math.min(window.innerWidth - 8, viewport.right, field.right);
      if (anchor.bottom < top || anchor.top > bottom || right <= left) { toolbar.hidden = true; return; }
      toolbar.hidden = false;
      const width = toolbar.offsetWidth, height = toolbar.offsetHeight;
      if (bottom - top < height + 8) { toolbar.hidden = true; return; }
      const x = Math.max(left, Math.min(right - width, (anchor.left + anchor.right - width) / 2));
      const above = anchor.top - height - 8;
      const y = Math.max(top + 4, Math.min(bottom - height - 4, above >= top + 4 ? above : anchor.bottom + 8));
      const origin = measure.parentElement!.getBoundingClientRect();
      toolbar.style.left = `${x - origin.left}px`;
      toolbar.style.top = `${y - origin.top}px`;
    }
    position();
    const resize = new ResizeObserver(position);
    resize.observe(input); resize.observe(toolbar);
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => { resize.disconnect(); document.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); };
  }, [editor, mirror, toolbar, selection, dragging]);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!editor.current?.contains(target) && !toolbar?.contains(target)) onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [editor, toolbar, selection, onDismiss]);

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && selection) {
      event.preventDefault(); event.stopPropagation(); onDismiss();
    }
  }
  function onToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onDismiss(); editor.current?.focus({ preventScroll: true });
    }
  }
  return { onPointerDown: () => setDragging(true), onEditorKeyDown, onToolbarKeyDown };
}
