import React, { useRef, useState } from 'react';
import { MIN_PANE_WIDTH, resizePair } from './ui-state.js';

export function ResizableConversations({ layoutKey, labels, children, parallel }) {
  const gridRef = useRef(null);
  const dragRef = useRef(null);
  const [layouts, setLayouts] = useState({});
  const widths = layouts[layoutKey];
  const measure = () => [...gridRef.current.children].map((element) => element.getBoundingClientRect().width);
  const update = (next) => setLayouts((current) => ({ ...current, [layoutKey]: next }));

  function finish(event, cancel = false) {
    if (!dragRef.current) return;
    if (cancel) update(dragRef.current.widths);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div ref={gridRef} className={`conversation-grid ${parallel ? 'parallel' : 'focus'} count-${children.length}`} style={{ gridTemplateColumns: parallel ? children.map((_, index) => `minmax(${MIN_PANE_WIDTH}px, ${widths?.[index] || 1}fr)`).join(' ') : 'minmax(0, 1fr)' }}>
    {children.map((child, index) => <div className="conversation-slot" key={child.key}>
      {child}
      {parallel && index < children.length - 1 && <div
        className="pane-separator"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={`调整${labels[index]}与${labels[index + 1]}的列宽`}
        aria-valuenow={Math.round(widths ? widths[index] / (widths[index] + widths[index + 1]) * 100 : 50)}
        aria-valuemin={0}
        aria-valuemax={100}
        title="拖动调整列宽，双击恢复等宽"
        onDoubleClick={() => update(undefined)}
        onKeyDown={(event) => {
          if (event.key === 'Home') { event.preventDefault(); update(undefined); }
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          update(resizePair(measure(), index, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 64 : 24)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, widths: measure() };
        }}
        onPointerMove={(event) => {
          if (dragRef.current) update(resizePair(dragRef.current.widths, index, event.clientX - dragRef.current.x));
        }}
        onPointerUp={finish}
        onPointerCancel={(event) => finish(event, true)}
      />}
    </div>)}
  </div>;
}
