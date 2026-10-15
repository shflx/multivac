import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from 'react';
import type { NoteSelection } from '@multivac/contracts';

/** 在真实渲染内容的原生选区旁定位引用入口，不改写正文 DOM。 */
export function useNoteSelectionToolbar({ editor, toolbar, selection, onDismiss }: {
  editor: RefObject<HTMLDivElement | null>;
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
    const input = editor.current;
    if (!input) return;
    function position() {
      if (!toolbar || !input || !selection) return;
      const field = input.getBoundingClientRect();
      const native = window.getSelection();
      if (!field.width || !native?.rangeCount || native.isCollapsed || !input.contains(native.anchorNode) || !input.contains(native.focusNode)) { toolbar.hidden = true; return; }
      const range = native.getRangeAt(0);
      const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
      const backward = native.anchorNode === range.endContainer && native.anchorOffset === range.endOffset;
      const anchor = backward ? rects[0] : rects.at(-1);
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
      const origin = input.closest('.note-writing-surface')!.getBoundingClientRect();
      toolbar.style.left = `${x - origin.left}px`;
      toolbar.style.top = `${y - origin.top}px`;
    }
    position();
    const resize = new ResizeObserver(position);
    resize.observe(input); resize.observe(toolbar);
    document.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => { resize.disconnect(); document.removeEventListener('scroll', position, true); window.removeEventListener('resize', position); };
  }, [editor, toolbar, selection, dragging]);

  useEffect(() => {
    if (!selection) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!editor.current?.contains(target) && !toolbar?.contains(target)) onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [editor, toolbar, selection, onDismiss]);

  function onEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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
