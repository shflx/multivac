import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { BookImage } from '@multivac/contracts';
import type { ReadingImageFrame } from './reading-layout.js';
import { ReadingImage } from './reading-images.js';

export function ReadingImageZoomControls({ zoom, disabled, change }: { zoom: number; disabled: boolean; change: (zoom: number) => void }) {
  return <div className="reading-image-zoom-controls" role="group" aria-label="图片页缩放" onKeyDown={event => {
    if (event.key === 'Escape' && zoom > 1) { event.preventDefault(); event.stopPropagation(); change(1); }
  }}>
    <button type="button" className="reading-icon" aria-label="缩小图片页" title="缩小图片页" disabled={disabled || zoom <= 1} onClick={() => change(Math.max(1, zoom - .5))}><ZoomOut size={16} /></button>
    <span aria-live="polite" aria-label="图片页缩放比例">{Math.round(zoom * 100)}%</span>
    <button type="button" className="reading-icon" aria-label="放大图片页" title="放大图片页" disabled={disabled || zoom >= 4} onClick={() => change(Math.min(4, zoom + .5))}><ZoomIn size={16} /></button>
    <button type="button" className="reading-icon" aria-label="适配图片页" title="适配图片页" disabled={zoom === 1} onClick={() => change(1)}><Maximize size={16} /></button>
  </div>;
}

export interface ReadingImageZoomView { x: number; y: number; focused: boolean }

function imageBounds(frames: ReadingImageFrame[]) {
  if (!frames.length) return { left: 0, top: 0, width: 1, height: 1 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const frame of frames) {
    left = Math.min(left, frame.left); top = Math.min(top, frame.top);
    right = Math.max(right, frame.left + frame.width); bottom = Math.max(bottom, frame.top + frame.height);
  }
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function captureReadingImageZoomView(stage: HTMLElement, frames: ReadingImageFrame[], zoom: number): ReadingImageZoomView {
  const bounds = imageBounds(frames);
  return {
    x: ((stage.scrollLeft + stage.clientWidth / 2) / zoom - bounds.left) / bounds.width,
    y: ((stage.scrollTop + stage.clientHeight / 2) / zoom - bounds.top) / bounds.height,
    focused: stage.contains(document.activeElement),
  };
}

/** 只缩放当前页的显示快照；原多栏正文继续保留测量尺寸与稳定原文锚点。 */
export function ReadingImageZoom({ bookId, frames, images, width, height, zoom, reset, stage, initialView }: {
  bookId: string; frames: ReadingImageFrame[]; images: Map<string, BookImage>;
  width: number; height: number; zoom: number; reset: () => void;
  stage: RefObject<HTMLDivElement | null>; initialView: ReadingImageZoomView | null;
}) {
  const previousZoom = useRef<number | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    if (previousZoom.current === null && initialView) {
      // 按图片区域的相对中心恢复；目标图片较小时，浏览器自动限制越界的距离。
      const bounds = imageBounds(frames);
      element.scrollLeft = (bounds.left + initialView.x * bounds.width) * zoom - element.clientWidth / 2;
      element.scrollTop = (bounds.top + initialView.y * bounds.height) * zoom - element.clientHeight / 2;
      if (initialView.focused && (document.activeElement === document.body || document.activeElement === element.parentElement)) element.focus({ preventScroll: true });
    } else {
      // 以视口中心为缩放中心，连续放大、缩小时保留正在看的区域。
      const previous = previousZoom.current ?? 1;
      element.scrollLeft = (element.scrollLeft + element.clientWidth / 2) * zoom / previous - element.clientWidth / 2;
      element.scrollTop = (element.scrollTop + element.clientHeight / 2) * zoom / previous - element.clientHeight / 2;
    }
    previousZoom.current = zoom;
  }, [zoom, initialView, stage, frames]);
  function endDrag() { drag.current = null; setDragging(false); }
  return <div ref={stage} className={`reading-image-zoom-stage${dragging ? ' dragging' : ''}`} tabIndex={0} role="region" aria-label="放大的图片页" title="拖动或滚动查看图片，方向键移动，PageUp / PageDown 翻页"
    onPointerDown={event => {
      // 触屏使用原生滚动；鼠标左键可以拖动，重试按钮仍按普通按钮处理。
      if (event.pointerType !== 'mouse' || event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.pointerId !== event.pointerId) return;
      event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
      event.currentTarget.scrollTop = start.top + start.y - event.clientY;
    }}
    onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { event.currentTarget.releasePointerCapture(event.pointerId); endDrag(); } }}
    onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.target instanceof Element && event.target.closest('button'))) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); return; }
      const left = event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0;
      const top = event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0;
      if (left || top) { event.preventDefault(); event.stopPropagation(); event.currentTarget.scrollBy({ left, top }); }
    }}>
    <div className="reading-image-zoom-canvas" style={{ width: width * zoom, height: height * zoom }}>
      {frames.map(frame => {
        const image = images.get(frame.id);
        return image && <div className="reading-image-zoom-frame" key={frame.id} style={{ left: frame.left * zoom, top: frame.top * zoom, width: frame.width * zoom, height: frame.height * zoom }}>
          <ReadingImage bookId={bookId} chapterId={frame.chapterId} paragraphId={frame.paragraphId} image={image} loading="eager" style={{ width: '100%', height: '100%' }} />
        </div>;
      })}
    </div>
  </div>;
}
