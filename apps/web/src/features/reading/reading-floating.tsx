import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/** 浮层只测量自身与容器，不改变正文宽高；软键盘出现时以可见视口重新夹取。 */
export function useReadingFloating(root: RefObject<HTMLElement | null>, anchor: HTMLElement | DOMRect | null, card = false, enabled = true) {
  const box = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const position = () => {
      const bounds = root.current?.getBoundingClientRect(), element = box.current;
      if (!bounds?.width || !element) return;
      const visual = window.visualViewport;
      const left = Math.max(bounds.left, visual?.offsetLeft ?? 0), right = Math.min(bounds.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth));
      const top = Math.max(bounds.top, visual?.offsetTop ?? 0), bottom = Math.min(bounds.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight));
      const size = element.getBoundingClientRect();
      const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, Math.max(min, max)));
      const y = card ? bottom - size.height - 68 : (rect?.bottom ?? top) + size.height + 8 < bottom - 62 ? (rect?.bottom ?? top) + 8 : (rect?.top ?? top) - size.height - 8;
      const next: CSSProperties = { visibility: 'visible', left: clamp(card ? right - size.width - 12 : rect?.left ?? left, left + 8, right - size.width - 8) - bounds.left, top: clamp(y, top + 8, bottom - size.height - 62) - bounds.top, maxHeight: Math.max(100, bottom - top - 84) };
      setStyle(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    const observer = new ResizeObserver(schedule);
    if (root.current) observer.observe(root.current); if (box.current) observer.observe(box.current);
    window.addEventListener('resize', schedule); visualViewport?.addEventListener('resize', schedule); visualViewport?.addEventListener('scroll', schedule); schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', schedule); visualViewport?.removeEventListener('resize', schedule); visualViewport?.removeEventListener('scroll', schedule); };
  }, [root, anchor, card, enabled]);
  return { ref: box, style };
}
export interface ReadingAction { label: string; run: () => void; disabled?: boolean }
export function ReadingActionsMenu({ root, anchor, actions, close, label }: { root: RefObject<HTMLElement | null>; anchor: HTMLElement; actions: ReadingAction[]; close: () => void; label: string }) {
  const floating = useReadingFloating(root, anchor);
  useLayoutEffect(() => { if (floating.style.visibility === 'visible') floating.ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [floating.style.visibility]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !floating.ref.current?.contains(event.target) && !anchor.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [anchor]);
  function dismiss() { close(); if (anchor.isConnected) anchor.focus(); }
  return <div {...floating} className="reading-actions-menu" role="menu" tabIndex={-1} aria-label={label} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); dismiss(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement), index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  }}>{actions.map(action => <button role="menuitem" key={action.label} disabled={action.disabled} onClick={() => { close(); action.run(); }}>{action.label}</button>)}</div>;
}
