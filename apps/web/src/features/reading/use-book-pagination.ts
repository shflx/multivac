import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BookIndex, BookPosition } from '@multivac/contracts';
import { getCachedBookWindow } from './reading-window-cache.js';
import { measureReadingPages } from './reading-layout.js';

interface PageLocation { start: BookPosition; end: BookPosition }
interface BookPagination { blocks: PageLocation[][]; offsets: number[]; total: number }
// 只缓存位置索引，不保留全书正文或测量 DOM；同一窗口重开和切回排版可以直接复用。
const cache = new Map<string, BookPagination>();

export function useBookPagination(index: BookIndex | undefined, box: string, active: boolean, root: RefObject<HTMLElement | null>) {
  const [attempt, setAttempt] = useState(0);
  const [fontVersion, setFontVersion] = useState(0);
  const [state, setState] = useState<{ key: string; data?: BookPagination; progress: number; error: string }>({ key: '', progress: 0, error: '' });
  const needed = Boolean(index && index.blockCount > 1);
  const key = needed && box ? `${index!.id}/${index!.version}/${box}/${fontVersion}` : '';
  const latest = useRef(key); latest.current = key;
  useEffect(() => {
    const changed = () => { cache.clear(); setFontVersion(value => value + 1); };
    document.fonts.addEventListener('loadingdone', changed);
    return () => document.fonts.removeEventListener('loadingdone', changed);
  }, []);
  useEffect(() => {
    if (!active || !index || !key || !root.current) return;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); setState({ key, data: cached, progress: 100, error: '' }); return; }
    let cancelled = false;
    const [width, height, fontSize] = box.split('/').map(Number);
    if (!width || !height || !fontSize) return;
    const host = document.createElement('div');
    host.className = 'reading-page-viewport'; host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, height: `${height}px`, maxWidth: 'none', visibility: 'hidden', pointerEvents: 'none', margin: '0', flex: 'none' });
    const flow = document.createElement('div'); flow.className = 'reading-flow'; flow.style.fontSize = `${fontSize}px`;
    host.append(flow); root.current.append(host);
    setState({ key, progress: 0, error: '' });
    void (async () => {
      try {
        await document.fonts.ready;
        const blocks: PageLocation[][] = [], offsets: number[] = []; let total = 0;
        for (let block = 0; block < index.blockCount; block++) {
          if (cancelled) return;
          const window = await getCachedBookWindow(index.id, block);
          if (cancelled || latest.current !== key) return;
          if (window.book.version !== index.version) throw new Error('书籍版本已变化，请重新打开书籍。');
          flow.replaceChildren();
          for (const chapter of window.book.chapters.filter(c => c.paragraphs.length)) {
            const section = document.createElement('section'); section.className = 'reading-flow-chapter';
            for (const paragraph of chapter.paragraphs) {
              const p = document.createElement('p'); p.dataset.chapter = chapter.id; p.dataset.paragraph = paragraph.id;
              const span = document.createElement('span'); span.textContent = paragraph.text; p.append(span); section.append(p);
            }
            flow.append(section);
          }
          const pages = measureReadingPages(window.book, flow, width).map(({ start, end }) => ({ start, end }));
          if (!pages.length) throw new Error('暂时无法完成分页，请重试。');
          offsets.push(total); blocks.push(pages); total += pages.length;
          setState({ key, progress: Math.floor((block + 1) / index.blockCount * 100), error: '' });
          // 每次只测量一块，并在两次测量间把主线程交还给界面。
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (cancelled || latest.current !== key) return;
        const data = { blocks, offsets, total };
        cache.set(key, data); while (cache.size > 4) cache.delete(cache.keys().next().value!);
        setState({ key, data, progress: 100, error: '' });
      } catch (error) {
        if (!cancelled) setState({ key, progress: 0, error: (error as Error).message });
      } finally { host.remove(); }
    })();
    return () => { cancelled = true; host.remove(); };
  }, [key, active, attempt, index, root]);
  const current = state.key === key ? state : null;
  return { needed, data: current?.data, progress: current?.progress ?? 0, error: current?.error ?? '', ready: !needed || Boolean(key && current?.data), retry: () => setAttempt(value => value + 1) };
}
