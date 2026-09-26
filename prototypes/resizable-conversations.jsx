import React, { useLayoutEffect, useRef, useState } from 'react';
import { MIN_PANE_WIDTH, resizeColumns } from './ui-state.js';

/**
 * 并排会话的列宽由调用方持有（随工作区现场保存）：widths 是各栏的相对宽度，缺省为等宽。
 * 每相邻两栏之间都有分隔线，可拖动或用方向键调整，双击或 Home 恢复等宽；
 * 每栏不窄于 MIN_PANE_WIDTH，放不下时由网格自身横向滚动，不挤压外侧的侧栏。
 */
export function ResizableConversations({ labels, children, parallel, widths: storedWidths, onWidthsChange }) {
  const gridRef = useRef(null);
  const dragRef = useRef(null);
  const [available, setAvailable] = useState(0);
  const widths = storedWidths?.length === children.length ? storedWidths : undefined;
  const measure = () => [...gridRef.current.children].map((element) => element.getBoundingClientRect().width);
  const isOverflowing = () => gridRef.current.scrollWidth > gridRef.current.clientWidth + 1;
  const update = (next) => onWidthsChange(next);

  // 记录网格可用宽度：保存的列宽总和超出时按像素排布并横向滚动，否则按比例铺满。
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const observer = new ResizeObserver(() => setAvailable(grid.clientWidth));
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const total = widths ? widths.reduce((sum, width) => sum + width, 0) + widths.length - 1 : 0;
  const columns = !parallel ? 'minmax(0, 1fr)'
    : !widths ? children.map(() => `minmax(${MIN_PANE_WIDTH}px, 1fr)`).join(' ')
    : total > available ? widths.map((width) => `${Math.max(MIN_PANE_WIDTH, Math.round(width))}px`).join(' ')
    : widths.map((width) => `minmax(${MIN_PANE_WIDTH}px, ${width}fr)`).join(' ');

  function finish(event, cancel = false) {
    if (!dragRef.current) return;
    if (cancel) update(dragRef.current.widths);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return <div ref={gridRef} className={`conversation-grid ${parallel ? 'parallel' : 'focus'} count-${children.length}`} style={{ gridTemplateColumns: columns }}>
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
          update(resizeColumns(measure(), index, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 64 : 24), isOverflowing()));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, widths: measure(), overflowing: isOverflowing() };
        }}
        onPointerMove={(event) => {
          if (dragRef.current) update(resizeColumns(dragRef.current.widths, index, event.clientX - dragRef.current.x, dragRef.current.overflowing));
        }}
        onPointerUp={finish}
        onPointerCancel={(event) => finish(event, true)}
      />}
    </div>)}
  </div>;
}
