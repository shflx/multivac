import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, List, Type as FontIcon } from 'lucide-react';
import { bookParagraphs, positionRank, type Book, type BookPosition } from '@multivac/contracts';
import { measureReadingPages, pageForPosition, type ReadingPage } from './reading-layout.js';

interface Scene { version: string; position: BookPosition; fontSize: number; navigation: boolean; returnPosition: BookPosition | null }
function initialScene(book: Book): Scene {
  const p = bookParagraphs(book)[0]!;
  const base: Scene = { version: book.version, position: { chapterId: p.chapterId, paragraphId: p.id, offset: 0 }, fontSize: 18, navigation: false, returnPosition: null };
  try {
    const saved = JSON.parse(localStorage.getItem(`multivac.reading.scene.${book.id}`) ?? 'null') as Scene | null;
    if (saved?.version === book.version && positionRank(book, saved.position) >= 0) return { ...base, ...saved, fontSize: Math.min(32, Math.max(14, Number(saved.fontSize) || 18)) };
  } catch { /* 本机现场损坏时回到书籍首段，不修改业务记录。 */ }
  return base;
}
export function ReadingReader({ book, active }: { book: Book; active: boolean }) {
  const [scene, setScene] = useState(() => initialScene(book));
  const [pages, setPages] = useState<ReadingPage[]>([]);
  const [input, setInput] = useState('');
  const [fontOpen, setFontOpen] = useState(false);
  const [error, setError] = useState('');
  const flow = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fontButton = useRef<HTMLButtonElement>(null);
  const pageIndex = pageForPosition(book, pages, scene.position);
  const page = pages[pageIndex];
  useEffect(() => {
    try { localStorage.setItem(`multivac.reading.scene.${book.id}`, JSON.stringify(scene)); setError(''); }
    catch { setError('本机无法保存阅读现场。'); }
  }, [book.id, scene]);
  useLayoutEffect(() => {
    if (!active || !flow.current || !viewport.current) return;
    let frame = 0; let disposed = false;
    const measure = () => {
      if (!flow.current || !viewport.current || !viewport.current.clientWidth) return;
      const next = measureReadingPages(book, flow.current, viewport.current.clientWidth);
      setPages(next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule); observer.observe(viewport.current);
    void document.fonts.ready.then(() => { if (!disposed) schedule(); });
    document.fonts.addEventListener('loadingdone', schedule); schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); document.fonts.removeEventListener('loadingdone', schedule); };
  }, [book, active, scene.fontSize]);
  function turn(index: number) { const next = pages[Math.max(0, Math.min(pages.length - 1, index))]; if (next) setScene(s => ({ ...s, position: next.start })); setInput(''); }
  function locate(position: BookPosition) { if (positionRank(book, position) < 0) { setError('原位置已失效。'); return; } setScene(s => ({ ...s, returnPosition: s.returnPosition ?? s.position, position })); }
  return <section className="reading-reader" onKeyDown={event => {
    if (event.key === 'Escape' && fontOpen) { event.stopPropagation(); setFontOpen(false); fontButton.current?.focus(); }
    if (event.nativeEvent.isComposing || event.target instanceof HTMLElement && event.target.closest('input,textarea,button,select,[contenteditable=true]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); turn(pageIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
  }}>
    <header className="reading-toolbar"><h2>{book.title}</h2><button className="reading-command" title="目录" aria-label="目录" aria-expanded={scene.navigation} onClick={() => setScene(s => ({ ...s, navigation: !s.navigation }))}><List size={18} /></button><button ref={fontButton} className="reading-command" title="字号" aria-label="字号" aria-expanded={fontOpen} onClick={() => setFontOpen(v => !v)}><FontIcon size={18} /></button>
      {fontOpen && <div className="reading-font-popover"><label>字号 <input type="range" min={14} max={32} step={2} value={scene.fontSize} onChange={event => setScene(s => ({ ...s, fontSize: Number(event.target.value) }))} /></label></div>}
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="reading-reader-body">
      {scene.navigation && <nav className="reading-toc" aria-label="目录">{book.chapters.filter(c => c.paragraphs.length).map(c => <button onClick={() => locate({ chapterId: c.id, paragraphId: c.paragraphs[0]!.id, offset: 0 })} key={c.id}>{c.title}</button>)}</nav>}
      <div className="reading-page-main">
        <div className="reading-chapter-title">{book.chapters.find(c => c.id === page?.start.chapterId)?.title}{scene.returnPosition && <button className="reading-command" onClick={() => setScene(s => ({ ...s, position: s.returnPosition!, returnPosition: null }))}><ArrowLeft size={16} />返回阅读处</button>}</div>
        <div ref={viewport} className="reading-page-viewport" tabIndex={0} aria-label="书籍正文">
          <div ref={flow} className="reading-flow" style={{ fontSize: scene.fontSize, transform: `translateX(-${pageIndex * (viewport.current?.clientWidth ?? 0)}px)` }}>
            {book.chapters.filter(c => c.paragraphs.length).map(c => <section className="reading-flow-chapter" key={c.id}>{c.paragraphs.map(p => <p key={p.id} data-paragraph={p.id} data-chapter={c.id}>{p.text}</p>)}</section>)}
          </div>
        </div>
        <footer className="reading-pagination"><button className="reading-command" title="上一页" aria-label="上一页" disabled={!page || pageIndex === 0} onClick={() => turn(pageIndex - 1)}><ArrowLeft size={18} /></button>
          <form onSubmit={event => { event.preventDefault(); const n = Number(input); if (Number.isInteger(n) && n >= 1 && n <= pages.length) turn(n - 1); else setError('页码超出范围。'); }}><label>页码 <input aria-label="页码" inputMode="numeric" value={input || String(pageIndex + 1)} onChange={event => setInput(event.target.value)} onFocus={event => event.target.select()} /></label><span> / {pages.length || '...'} 页</span><button className="reading-command" title="跳转" aria-label="跳转"><ArrowRight size={16} /></button></form>
          <button className="reading-command" title="下一页" aria-label="下一页" disabled={!page || pageIndex === pages.length - 1} onClick={() => turn(pageIndex + 1)}><ArrowRight size={18} /></button>
        </footer>
      </div>
    </div>
  </section>;
}
