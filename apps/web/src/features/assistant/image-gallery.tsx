import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react';
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

function ImagePreview({ sources, start, close }: { sources: ImageSource[]; start: number; close: () => void }) {
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(1);
  const dialog = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => opener?.focus();
  }, []);
  function move(offset: number) { setIndex(value => (value + offset + sources.length) % sources.length); setZoom(1); setFailed(false); }
  const source = sources[index]!;
  return createPortal(<div ref={dialog} className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览"
    onClick={event => { if (event.target === event.currentTarget) close(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (event.key === 'Tab') {
        const controls = focusableWithin(event.currentTarget);
        const next = wrapFocusIndex(controls.length, controls.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        if (next !== null) { event.preventDefault(); controls[next]?.focus(); }
      }
    }}>
    <div className="image-preview-toolbar">
      <button type="button" aria-label="关闭图片预览" title="关闭" onClick={close}><X /></button>
      <button type="button" aria-label="上一张图片" title="上一张" disabled={sources.length < 2} onClick={() => move(-1)}><ChevronLeft /></button>
      <span aria-live="polite">{index + 1} / {sources.length}</span>
      <button type="button" aria-label="下一张图片" title="下一张" disabled={sources.length < 2} onClick={() => move(1)}><ChevronRight /></button>
      <button type="button" aria-label="缩小图片" title="缩小" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}><ZoomOut /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大图片" title="放大" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.5))}><ZoomIn /></button>
    </div>
    <div className="image-preview-stage">{failed ? <p role="alert">图片不可用</p> : <img key={source.url} src={source.url} alt={source.alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: 'none', maxHeight: 'none' } : undefined} />}</div>
  </div>, document.body);
}

export function ImageGallery({ sources }: { sources: ImageSource[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  return <span className="message-images">{sources.map((source, index) => <ImageThumbnail key={`${source.url}:${index}`} source={source} open={() => setSelected(index)} />)}{selected !== null && sources[selected] && <ImagePreview sources={sources} start={selected} close={() => setSelected(null)} />}</span>;
}
