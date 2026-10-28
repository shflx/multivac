import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * 标题旁的说明气泡：悬停或聚焦时显示，点击可固定；Esc 或点击外部关闭。
 * 说明不占正文空间，适合放低频但需要可查的规则。
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!pinned) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setPinned(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [pinned]);
  return <span className="info-tip" ref={root} data-pinned={pinned || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && pinned) { event.stopPropagation(); setPinned(false); } }}>
    <button type="button" className="info-tip-trigger" aria-label={label} aria-expanded={pinned} aria-describedby={id} onClick={() => setPinned(value => !value)}>
      <Info aria-hidden="true" />
    </button>
    <span className="info-tip-bubble" id={id} role="tooltip">{children}</span>
  </span>;
}
