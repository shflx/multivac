import { useState, type ReactNode } from 'react';
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
function ReadingImage({ bookId, chapterId, paragraphId, image }: { bookId: string; chapterId: string; paragraphId: string; image: BookImage }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const failed = Boolean(image.error || !image.resourceId || state === 'failed');
  return <span className="reading-image" style={imageFrameStyle(image)} data-reading-image={image.id} data-chapter={chapterId} data-paragraph={paragraphId} data-offset={image.offset} contentEditable={false}>
    {image.resourceId && !image.error && <img key={attempt} src={bookImageUrl(bookId, image.resourceId) + (attempt ? `?retry=${attempt}` : '')} alt={image.alt || '书内插图'} width={image.width} height={image.height} loading="lazy" decoding="async" draggable={false} onLoad={() => setState('ready')} onError={() => setState('failed')} />}
    {(failed || state === 'loading') && <span className="reading-image-feedback" role="status">
      <span>{failed ? `图片不可用：${image.error || '资源加载失败'}` : '正在加载图片…'}</span><small>{image.alt || '书内插图'}</small>
      {failed && image.resourceId && !image.error && <button type="button" className="reading-command" onClick={() => { setState('loading'); setAttempt(n => n + 1); }}>重试图片</button>}
    </span>}
  </span>;
}
export function ReadingParagraphContent({ bookId, chapterId, paragraph, renderText }: { bookId: string; chapterId: string; paragraph: Paragraph; renderText: (start: number, end: number) => ReactNode }) {
  return <>{paragraphRuns(paragraph).map((run, index) => run.kind === 'image'
    ? <ReadingImage key={run.image.id} bookId={bookId} chapterId={chapterId} paragraphId={paragraph.id} image={run.image} />
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
