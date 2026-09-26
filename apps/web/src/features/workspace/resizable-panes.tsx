import { isValidElement, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { gridColumns, pairPercent, resizeColumns } from './pane-layout.js';

/** 键盘调整步长（px）；按住 Shift 时步长更大。 */
const KEYBOARD_STEP_PX = 24;
const KEYBOARD_LARGE_STEP_PX = 64;

interface ResizablePanesProps {
  /** 各栏相对宽度；未调整过为 undefined（等宽）。 */
  widths: readonly number[] | undefined;
  /** 恢复等宽时传入 undefined。 */
  onWidthsChange: (widths: number[] | undefined) => void;
  /** 各栏名称，用于分隔线的可访问标签。 */
  labels: readonly string[];
  /** 每栏一个元素，需带稳定的 key。 */
  children: readonly ReactNode[];
}

/**
 * 多栏并排布局：每相邻两栏之间都有分隔线，可拖动或用键盘调整列宽，双击或 Home 恢复等宽。
 * 每栏都不小于最小宽度；可用宽度不足时由网格自身横向滚动，不挤压外侧的侧栏。
 */
export function ResizablePanes({ widths: storedWidths, onWidthsChange, labels, children }: ResizablePanesProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; widths: number[]; overflowing: boolean } | null>(null);
  const [available, setAvailable] = useState(0);
  const widths = storedWidths?.length === children.length ? storedWidths : undefined;

  // 记录网格可用宽度：保存的列宽总和超出时按像素排布并横向滚动，否则按比例铺满。
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    setAvailable(grid.clientWidth);
    const observer = new ResizeObserver(() => setAvailable(grid.clientWidth));
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const measure = () => [...(gridRef.current?.children ?? [])].map((element) => element.getBoundingClientRect().width);
  const isOverflowing = () => {
    const grid = gridRef.current;
    return Boolean(grid && grid.scrollWidth > grid.clientWidth + 1);
  };

  function finish(event: PointerEvent<HTMLDivElement>, cancel = false): void {
    const drag = dragRef.current;
    if (!drag) return;
    if (cancel) onWidthsChange(drag.widths);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number): void {
    if (event.key === 'Home') {
      event.preventDefault();
      onWidthsChange(undefined);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP_PX : KEYBOARD_STEP_PX;
    onWidthsChange(resizeColumns(measure(), index, event.key === 'ArrowLeft' ? -step : step, isOverflowing()));
  }

  return (
    <div
      ref={gridRef}
      className={`workspace-panels parallel count-${children.length}`}
      style={{ gridTemplateColumns: gridColumns(children.length, widths, available) }}
    >
      {children.map((child, index) => (
        <div className="workspace-slot" key={isValidElement(child) && child.key !== null ? child.key : index}>
          {child}
          {index < children.length - 1 && (
            <div
              className="pane-separator"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label={`调整「${labels[index]}」与「${labels[index + 1]}」的列宽`}
              aria-valuenow={pairPercent(widths, index)}
              aria-valuemin={0}
              aria-valuemax={100}
              title="拖动调整列宽，双击恢复等宽"
              onDoubleClick={() => onWidthsChange(undefined)}
              onKeyDown={(event) => onKeyDown(event, index)}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { x: event.clientX, widths: measure(), overflowing: isOverflowing() };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (drag) onWidthsChange(resizeColumns(drag.widths, index, event.clientX - drag.x, drag.overflowing));
              }}
              onPointerUp={(event) => finish(event)}
              onPointerCancel={(event) => finish(event, true)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
