import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BookImage, Book } from '@multivac/contracts';

type Paragraph = Book['chapters'][number]['paragraphs'][number];
export function paragraphRuns(paragraph: Paragraph) {
  const runs: ({ kind: 'text'; start: number; end: number } | { kind: 'image'; image: BookImage })[] = [];
  let start = 0;
  for (const image of paragraph.images ?? []) {
    if (image.offset > start) runs.push({ kind: 'text', start, end: image.offset });
    runs.push({ kind: 'image', image }); start = image.offset;
  }
  if (start < paragraph.text.length) runs.push({ kind: 'text', start, end: paragraph.text.length });
  return runs;
}
export const bookImageUrl = (bookId: string, resourceId: string) => `/api/reading/books/${encodeURIComponent(bookId)}/images/${resourceId}`;
/** 以已保存的尺寸约束占位，下载、解码及失败反馈均不改变分页几何。 */
export function imageFrameStyle(image: BookImage) {
  return { width: `min(100%, ${image.width}px, calc(max(1px, 100cqh - 2em) * ${image.width / image.height}))`, aspectRatio: `${image.width} / ${image.height}` };
}
export function ReadingImage({ bookId, chapterId, paragraphId, image, style, loading = 'lazy', onReady }: { bookId: string; chapterId: string; paragraphId: string; image: BookImage; style?: CSSProperties; loading?: 'eager' | 'lazy'; onReady?: (id: string, ready: boolean) => void }) {
  const element = useRef<HTMLImageElement>(null);
  const [attempt, setAttempt] = useState(0);
  const src = image.resourceId && !image.error ? bookImageUrl(bookId, image.resourceId) + (attempt ? `?retry=${attempt}` : '') : null;
  const [result, setResult] = useState<{ src: string; state: 'ready' | 'failed'; error: string } | null>(null);
  const [slowSrc, setSlowSrc] = useState<string | null>(null);
  const state = result?.src === src ? result.state : 'loading';
  const slow = state === 'loading' && slowSrc === src;
  useEffect(() => {
    const node = element.current;
    if (!node || !src) { onReady?.(image.id, false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ready: boolean, error = '资源加载失败') => {
      if (cancelled) return;
      clearTimeout(timer);
      const next = { src, state: ready ? 'ready' as const : 'failed' as const, error };
      setResult(previous => previous?.src === src && previous.state === next.state && previous.error === error ? previous : next);
      onReady?.(image.id, ready);
    };
    const loaded = () => { if (node.complete) finish(node.naturalWidth > 0); };
    const failed = () => finish(false);
    node.addEventListener('load', loaded);
    node.addEventListener('error', failed);
    // 缓存命中或恢复现场时，load 事件可能已经发生；用真实解码结果补齐状态。
    if (node.complete) loaded();
    else if (loading === 'eager') {
      // 计时包含浏览器排队与下载时间，慢网络下仍可能成功；只提示并提供重试，不判定失败。
      timer = setTimeout(() => { if (!cancelled) setSlowSrc(src); }, 30_000);
      void node.decode().then(() => finish(node.naturalWidth > 0), failed);
    }
    return () => {
      cancelled = true; clearTimeout(timer);
      node.removeEventListener('load', loaded); node.removeEventListener('error', failed);
      onReady?.(image.id, false);
    };
  }, [src, image.id, loading, onReady]);
  const failed = Boolean(image.error || !src || state === 'failed');
  return <span className="reading-image" style={{ ...imageFrameStyle(image), ...style }} data-reading-image={image.id} data-chapter={chapterId} data-paragraph={paragraphId} data-offset={image.offset} contentEditable={false}>
    {/* 相邻页的懒加载图片会落入浏览器预取范围，降低其优先级，避免当前页图片排在后面。 */}
    {src && <img ref={element} key={src} src={src} alt={image.alt || '书内插图'} width={image.width} height={image.height} loading={loading} fetchPriority={loading === 'eager' ? 'high' : 'low'} decoding="async" draggable={false} />}
    {(failed || state === 'loading') && <span className="reading-image-feedback" role="status">
      <span>{failed ? `图片不可用：${image.error || (result?.src === src ? result.error : '') || '资源加载失败'}` : slow ? '图片加载较慢，仍在继续…' : '正在加载图片…'}</span><small>{image.alt || '书内插图'}</small>
      {(failed || slow) && src && <button type="button" className="reading-command" onClick={() => { onReady?.(image.id, false); setAttempt(n => n + 1); }}>重试图片</button>}
    </span>}
  </span>;
}
export function ReadingParagraphContent({ bookId, chapterId, paragraph, renderText, onImageReady, eagerImageIds = [] }: { bookId: string; chapterId: string; paragraph: Paragraph; renderText: (start: number, end: number) => ReactNode; onImageReady?: (id: string, ready: boolean) => void; eagerImageIds?: readonly string[] }) {
  return <>{paragraphRuns(paragraph).map((run, index) => run.kind === 'image'
    ? <ReadingImage key={run.image.id} bookId={bookId} chapterId={chapterId} paragraphId={paragraph.id} image={run.image} loading={eagerImageIds.includes(run.image.id) ? 'eager' : 'lazy'} {...(onImageReady ? { onReady: onImageReady } : {})} />
    : <span key={`text-${index}`} data-reading-text="" data-paragraph={paragraph.id} data-chapter={chapterId} data-offset={run.start}>{renderText(run.start, run.end)}</span>)}</>;
}
/** 全书测量复用同一分段和图片尺寸，测量时无须下载图片。 */
export function appendMeasuredParagraph(section: HTMLElement, chapterId: string, paragraph: Paragraph) {
  const p = document.createElement('p');
  for (const run of paragraphRuns(paragraph)) {
    const span = document.createElement('span'); span.dataset.chapter = chapterId; span.dataset.paragraph = paragraph.id;
    if (run.kind === 'text') {
      span.dataset.readingText = ''; span.dataset.offset = String(run.start); span.textContent = paragraph.text.slice(run.start, run.end);
    } else {
      span.dataset.readingImage = run.image.id; span.dataset.offset = String(run.image.offset); span.className = 'reading-image';
      Object.assign(span.style, imageFrameStyle(run.image));
    }
    p.append(span);
  }
  section.append(p);
}
