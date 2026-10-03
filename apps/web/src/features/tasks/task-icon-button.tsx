import { useEffect, useId, useState, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/** 沿用原型的浮层提示，避免提示被看板滚动区域裁切。 */
export function TaskIconButton({ label, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  const id = useId();
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);
  function show(element: HTMLButtonElement) {
    const rect = element.getBoundingClientRect();
    setAnchor({ left: Math.max(168, Math.min(window.innerWidth - 168, rect.left + rect.width / 2)), top: rect.bottom + 8 > window.innerHeight - 40 ? rect.top - 38 : rect.bottom + 8 });
  }
  useEffect(() => {
    if (!anchor) return;
    const hide = () => setAnchor(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide);
      window.removeEventListener('resize', hide);
    };
  }, [anchor]);
  return <><button type="button" className={`icon-button ${className}`} aria-label={label} aria-describedby={anchor ? id : undefined} onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => setAnchor(null)} onFocus={(event) => show(event.currentTarget)} onBlur={() => setAnchor(null)} onPointerDown={() => setAnchor(null)} onKeyDown={(event) => { if (anchor && event.key === 'Escape') { event.stopPropagation(); setAnchor(null); } }} {...props}>{children}</button>{anchor && createPortal(<span id={id} role="tooltip" className="task-control-tooltip" style={anchor}>{label}</span>, document.body)}</>;
}
