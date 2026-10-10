import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, X, ZoomIn, ZoomOut } from 'lucide-react';

/** 缩略图：加载中不可点开；加载失败显示“图片不可用”并可重新加载。 */
function ImageThumbnail({ source, open }) {
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setStatus('loading'), [source.url]);
  return <span className="message-image-item">
    <button type="button" className="message-image" aria-label={`查看图片 ${source.alt}`} disabled={status !== 'ready'} onClick={open}>
      <img key={attempt} src={source.url} alt={source.alt} loading="lazy" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />
      {status === 'loading' && <span role="status"><LoaderCircle className="status-spinner" />加载中</span>}
    </button>
    {status === 'error' && <span className="image-load-error" role="alert">图片不可用<button type="button" title="重新加载图片" aria-label="重新加载图片" onClick={() => { setStatus('loading'); setAttempt((value) => value + 1); }}><RefreshCw /></button></span>}
  </span>;
}

/** 预览：Esc 关闭，左右键切换，缩放 100%–400%（每次 50%），焦点限制在预览内，关闭后回到原按钮。 */
function ImagePreview({ sources, start, close }) {
  const [index, setIndex] = useState(start);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector('button')?.focus();
    return () => opener?.focus();
  }, []);

  function move(offset) {
    setIndex((value) => (value + offset + sources.length) % sources.length);
    setZoom(1);
    setFailed(false);
  }

  function onKeyDown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled)')];
      const at = controls.indexOf(document.activeElement);
      const next = event.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : (at === controls.length - 1 ? 0 : at + 1);
      event.preventDefault();
      controls[next]?.focus();
    }
  }

  const source = sources[index];
  return createPortal(<div ref={dialog} className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览" onClick={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={onKeyDown}>
    <div className="image-preview-toolbar">
      <button type="button" aria-label="关闭图片预览" title="关闭" onClick={close}><X /></button>
      <button type="button" aria-label="上一张图片" title="上一张" disabled={sources.length < 2} onClick={() => move(-1)}><ChevronLeft /></button>
      <span aria-live="polite">{index + 1} / {sources.length}</span>
      <button type="button" aria-label="下一张图片" title="下一张" disabled={sources.length < 2} onClick={() => move(1)}><ChevronRight /></button>
      <button type="button" aria-label="缩小图片" title="缩小" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.5))}><ZoomOut /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="放大图片" title="放大" disabled={zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.5))}><ZoomIn /></button>
    </div>
    <div className="image-preview-stage">{failed ? <p role="alert">图片不可用</p> : <img key={source.url} src={source.url} alt={source.alt} onError={() => setFailed(true)} style={zoom > 1 ? { width: `${zoom * 100}%`, maxWidth: 'none', maxHeight: 'none' } : undefined} />}</div>
  </div>, document.body);
}

/** 消息与草稿共用的图片组：缩略图排成一行，点开后在同一组内前后切换。 */
export function ImageGallery({ sources }) {
  const [selected, setSelected] = useState(null);
  return <span className="message-images">
    {sources.map((source, index) => <ImageThumbnail key={`${source.url}:${index}`} source={source} open={() => setSelected(index)} />)}
    {selected !== null && sources[selected] && <ImagePreview sources={sources} start={selected} close={() => setSelected(null)} />}
  </span>;
}
