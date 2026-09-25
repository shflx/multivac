import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { DEFAULT_SPLIT, MIN_PANE_WIDTH, clampSplit, resizeSplit, splitPercent } from './pane-layout.js';

/** 键盘调整步长（px）；按住 Shift 时步长更大。 */
const KEYBOARD_STEP_PX = 24;
const KEYBOARD_LARGE_STEP_PX = 64;

interface ResizablePanesProps {
  /** 左栏占比（0–1）。 */
  split: number;
  onSplitChange: (split: number) => void;
  /** 两栏的名称，用于分隔线的可访问标签。 */
  labels: readonly [string, string];
  children: readonly [ReactNode, ReactNode];
}

/**
 * 两栏并排布局：中间的分隔线可拖动或用键盘调整列宽，双击或 Home 恢复等宽。
 * 两栏都不小于最小宽度；可用宽度不足时容器横向滚动。
 */
export function ResizablePanes({ split, onSplitChange, labels, children }: ResizablePanesProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; split: number } | null>(null);
  const width = () => gridRef.current?.getBoundingClientRect().width ?? 0;
  const current = clampSplit(split, width());

  function finish(event: PointerEvent<HTMLDivElement>, cancel = false): void {
    const drag = dragRef.current;
    if (!drag) return;
    if (cancel) onSplitChange(drag.split);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Home') {
      event.preventDefault();
      onSplitChange(DEFAULT_SPLIT);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP_PX : KEYBOARD_STEP_PX;
    onSplitChange(resizeSplit(current, width(), event.key === 'ArrowLeft' ? -step : step));
  }

  return (
    <div
      ref={gridRef}
      className="workspace-panels parallel"
      style={{
        gridTemplateColumns: `minmax(${MIN_PANE_WIDTH}px, ${current}fr) minmax(${MIN_PANE_WIDTH}px, ${1 - current}fr)`,
      }}
    >
      <div className="workspace-slot">
        {children[0]}
        <div
          className="pane-separator"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={`调整「${labels[0]}」与「${labels[1]}」的列宽`}
          aria-valuenow={splitPercent(current)}
          aria-valuemin={0}
          aria-valuemax={100}
          title="拖动调整列宽，双击恢复等宽"
          onDoubleClick={() => onSplitChange(DEFAULT_SPLIT)}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { x: event.clientX, split: current };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag) onSplitChange(resizeSplit(drag.split, width(), event.clientX - drag.x));
          }}
          onPointerUp={(event) => finish(event)}
          onPointerCancel={(event) => finish(event, true)}
        />
      </div>
      <div className="workspace-slot">{children[1]}</div>
    </div>
  );
}
