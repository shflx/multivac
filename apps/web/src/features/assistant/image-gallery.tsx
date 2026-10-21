import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, LoaderCircle, Maximize, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';

export interface ImageSource { url: string; alt: string }

function ImageThumbnail({ source, open }: { source: ImageSource; open: () => void }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setStatus('loading'), [source.url]);
  return <span className="message-image-item">
    <button type="button" className="message-image" aria-label={`查看图片 ${source.alt}`} disabled={status !== 'ready'} onClick={open}>
      <img key={attempt} src={source.url} alt={source.alt} loading="lazy" referrerPolicy="no-referrer" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />
      {status === 'loading' && <span role="status"><LoaderCircle size={16} className="spin" />加载中</span>}
    </button>
    {status === 'error' && <span className="image-load-error" role="alert">图片不可用<button type="button" title="重新加载图片" aria-label="重新加载图片" onClick={() => { setStatus('loading'); setAttempt(value => value + 1); }}><RefreshCw size={14} /></button></span>}
  </span>;
}

/** 缩放倍数以“适应窗口”为 100%：按钮按 50% 档位前进，滚轮与触控板捏合连续缩放。 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;

interface Size { width: number; height: number }
/** 缩放锚点：视口内的位置，以及它落在图片上的相对位置。 */
interface ZoomAnchor { viewX: number; viewY: number; imageX: number; imageY: number }

function clampZoom(value: number) {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100;
}

/** 大图缩小到完整可见，小图保持原尺寸，不放大成模糊图。 */
function fitSize(natural: Size, box: Size): Size {
  const scale = Math.min(1, box.width / natural.width, box.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

export function ImagePreview({ sources, start, close, portalRoot }: { sources: ImageSource[]; start: number; close: () => void; portalRoot?: HTMLElement | null }) {
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [natural, setNatural] = useState<Size | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  const [dragging, setDragging] = useState(false);

  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const zoomRef = useRef(zoom);
  const anchor = useRef<ZoomAnchor | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  zoomRef.current = zoom;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => opener?.focus();
  }, []);

  // 适配尺寸取画布内容区，窗口或侧栏变化时重新计算。
  useLayoutEffect(() => {
    const element = stage.current;
    const content = canvas.current;
    if (!element || !content) return;
    const measure = () => {
      const style = getComputedStyle(content);
      setBox({
        width: Math.max(1, element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.max(1, element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 新尺寸落到 DOM 后再滚动，让锚点下的图片位置保持不动。
  useLayoutEffect(() => {
    const element = stage.current;
    const picture = image.current;
    const target = anchor.current;
    anchor.current = null;
    if (!element || !picture || !target) return;
    element.scrollLeft = picture.offsetLeft + target.imageX * picture.offsetWidth - target.viewX;
    element.scrollTop = picture.offsetTop + target.imageY * picture.offsetHeight - target.viewY;
  }, [zoom]);

  /** point 为视口坐标；省略时以舞台中心为锚点。 */
  function changeZoom(next: number, point?: { x: number; y: number }) {
    const value = clampZoom(next);
    if (value === zoomRef.current) return;
    const element = stage.current;
    const picture = image.current;
    if (element && picture && picture.offsetWidth && picture.offsetHeight) {
      const rect = element.getBoundingClientRect();
      const viewX = point ? point.x - rect.left : element.clientWidth / 2;
      const viewY = point ? point.y - rect.top : element.clientHeight / 2;
      anchor.current = {
        viewX, viewY,
        imageX: Math.min(1, Math.max(0, (element.scrollLeft + viewX - picture.offsetLeft) / picture.offsetWidth)),
        imageY: Math.min(1, Math.max(0, (element.scrollTop + viewY - picture.offsetTop) / picture.offsetHeight)),
      };
    }
    zoomRef.current = value;
    setZoom(value);
  }
  const zoomIn = () => changeZoom((Math.floor(zoomRef.current / ZOOM_STEP + 1e-6) + 1) * ZOOM_STEP);
  const zoomOut = () => changeZoom((Math.ceil(zoomRef.current / ZOOM_STEP - 1e-6) - 1) * ZOOM_STEP);

  // React 的 wheel 监听是被动的，拦截浏览器页面缩放需要原生监听；普通滚轮仍用于平移。
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeZoom(zoomRef.current * Math.exp(-event.deltaY / 300), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  function move(offset: number) {
    setIndex(value => (value + offset + sources.length) % sources.length);
    anchor.current = null;
    zoomRef.current = MIN_ZOOM;
    setZoom(MIN_ZOOM);
    setFailed(false);
    setNatural(null);
    stage.current?.scrollTo(0, 0);
  }

  function retry() {
    setFailed(false);
    setNatural(null);
    setAttempt(value => value + 1);
  }

  function endDrag() {
    drag.current = null;
    setDragging(false);
  }

  const source = sources[index]!;
  const fitted = natural && box ? fitSize(natural, box) : null;
  const pannable = zoom > MIN_ZOOM;
  return createPortal(<div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览"
    // Portal 内的事件仍沿 React 树冒泡；预览内滚动不应暂停底下消息列表的自动跟随。
    onWheel={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn(); }
      if (event.key === '-') { event.preventDefault(); zoomOut(); }
      if (event.key === '0') { event.preventDefault(); changeZoom(MIN_ZOOM); }
      if (event.key === 'Tab') {
        const controls = focusableWithin(event.currentTarget);
        const next = wrapFocusIndex(controls.length, controls.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next !== null) { event.preventDefault(); controls[next]?.focus(); }
      }
    }}>
    <header className="image-preview-toolbar">
      <div className="image-preview-title">
        <span className="image-preview-name" title={source.alt}>{source.alt}</span>
        {sources.length > 1 && <span className="image-preview-count" aria-live="polite">{index + 1} / {sources.length}</span>}
      </div>
      <div className="image-preview-actions">
        <div className="image-preview-zoom" role="group" aria-label="缩放">
          <button type="button" aria-label="缩小图片" title="缩小（-）" disabled={failed || zoom <= MIN_ZOOM} onClick={zoomOut}><ZoomOut /></button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="放大图片" title="放大（+）" disabled={failed || zoom >= MAX_ZOOM} onClick={zoomIn}><ZoomIn /></button>
          <button type="button" aria-label="适应窗口" title="适应窗口（0）" disabled={zoom === MIN_ZOOM} onClick={() => changeZoom(MIN_ZOOM)}><Maximize /></button>
        </div>
        <span className="image-preview-divider" aria-hidden="true" />
        <button ref={closeButton} type="button" aria-label="关闭图片预览" title="关闭（Esc）" onClick={close}><X /></button>
      </div>
    </header>
    <div className="image-preview-body">
      <div ref={stage} className={`image-preview-stage${pannable ? ' pannable' : ''}${dragging ? ' dragging' : ''}`}
        onClick={event => {
          // 拖动结束时的 click 不算点击空白处。
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (event.target === event.currentTarget || event.target === canvas.current) close();
        }}
        onDoubleClick={event => {
          if (event.target !== image.current) return;
          changeZoom(zoom > MIN_ZOOM ? MIN_ZOOM : 2, { x: event.clientX, y: event.clientY });
        }}
        onPointerDown={event => {
          // 触屏使用原生滚动；鼠标左键在放大后拖动平移。
          if (!pannable || event.pointerType !== 'mouse' || event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3) start.moved = true;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={event => {
          if (drag.current?.pointerId !== event.pointerId) return;
          suppressClick.current = drag.current.moved;
          event.currentTarget.releasePointerCapture(event.pointerId);
          endDrag();
        }}
        onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <div ref={canvas} className="image-preview-canvas">
          {failed
            ? <p className="image-preview-failed" role="alert">图片不可用<button type="button" aria-label="重新加载图片" title="重新加载图片" onClick={retry}><RefreshCw /></button></p>
            : <img ref={image} key={`${source.url}:${attempt}`} src={source.url} alt={source.alt} referrerPolicy="no-referrer" draggable={false}
              title={pannable ? '拖动查看，双击还原' : '双击放大'}
              style={fitted ? { width: fitted.width * zoom, height: fitted.height * zoom } : { visibility: 'hidden' }}
              onLoad={event => setNatural({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
              onError={() => setFailed(true)} />}
        </div>
      </div>
      {sources.length > 1 && <>
        <button type="button" className="image-preview-nav previous" aria-label="上一张图片" title="上一张（←）" onClick={() => move(-1)}><ChevronLeft /></button>
        <button type="button" className="image-preview-nav next" aria-label="下一张图片" title="下一张（→）" onClick={() => move(1)}><ChevronRight /></button>
      </>}
    </div>
  </div>, portalRoot ?? document.body);
}

export function ImageGallery({ sources }: { sources: ImageSource[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  return <span className="message-images">{sources.map((source, index) => <ImageThumbnail key={`${source.url}:${index}`} source={source} open={() => setSelected(index)} />)}{selected !== null && sources[selected] && <ImagePreview sources={sources} start={selected} close={() => setSelected(null)} />}</span>;
}
