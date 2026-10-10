import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { referenceText, readingNoteLocation, type Book, type BookReference, type BookPosition, type ReadingAnnotation, type ReadingNote } from '@multivac/contracts';
import type { PDFDocumentProxy, TextLayer } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './reading-pdf.css';
import { getPdfPage } from '../../data/reading-api.js';
import { mapPdfText, pdfTextPosition, pdfRawRanges, type PdfTextMap } from './reading-pdf-map.js';
import { validBookReference, positionRank, type ReadingBook } from './reading-book.js';
import { textEndpoint } from './reading-layout.js';

export interface PdfPageState {
  number: number; ready: boolean; book: Book | null; reference: BookReference | null;
  anchor: BookReference | null; warning: string; error: string;
}
interface LayerData { map: PdfTextMap; divs: { element: HTMLElement; start: number; end: number }[]; book: Book }
type Selection = { reference: BookReference; rect: DOMRect } | null;

export function capturePdfSelection(data: LayerData, layer: HTMLElement): Selection {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return null;
  const endpoint = (node: Node, offset: number, end: boolean) => {
    const div = data.divs.find(d => d.element === node || d.element.contains(node));
    if (!div) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(div.element); prefix.setEnd(node, offset);
    return pdfTextPosition(data.map, div.start + prefix.toString().length, end);
  };
  const start = endpoint(range.startContainer, range.startOffset, false), end = endpoint(range.endContainer, range.endOffset, true);
  if (!start || !end) return null;
  const text = referenceText(data.book, start, end);
  if (!text || text.length > 65536) return null;
  return { reference: { bookId: data.book.id, version: data.book.version, start, end, text }, rect: range.getBoundingClientRect() };
}

/** 只挂载一个原始页；切页/缩放取消旧渲染，迟到结果不能成为书伴当前页。 */
export function ReadingPdfPage({ book, number, zoom, active, records, notes, located, locatePosition, scroll, onScroll, onState, onSelection, onNote }: {
  book: ReadingBook; number: number; zoom: number; active: boolean; records: ReadingAnnotation[]; notes: ReadingNote[];
  located: BookReference | null; locatePosition: BookPosition | null; scroll: { x: number; y: number };
  onScroll: (value: { x: number; y: number }) => void; onState: (state: PdfPageState) => void;
  onSelection: (selection: Selection) => void; onNote: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), layer = useRef<HTMLDivElement>(null), marks = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onState, onSelection, onNote, onScroll }); callbacks.current = { onState, onSelection, onNote, onScroll };
  const scrollRef = useRef(scroll); scrollRef.current = scroll;
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentError, setDocumentError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [data, setData] = useState<LayerData | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  useLayoutEffect(() => {
    if (!host.current || !active) return;
    const observer = new ResizeObserver(([entry]) => { if (entry?.contentRect.width) setWidth(entry.contentRect.width); });
    observer.observe(host.current); return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let loading: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined;
    setDocument(null); setDocumentError('');
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        loading = pdfjs.getDocument({ url: `/api/reading/books/${encodeURIComponent(book.id)}/pdf/source`,
          rangeChunkSize: 65536, disableStream: true, disableAutoFetch: true,
          cMapUrl: '/api/reading/pdf-assets/cmaps/', cMapPacked: true,
          standardFontDataUrl: '/api/reading/pdf-assets/standard_fonts/', wasmUrl: '/api/reading/pdf-assets/wasm/',
          enableXfa: false, verbosity: 0,
        });
        const pdf = await loading.promise;
        if (disposed) return;
        if (pdf.numPages !== (book.index?.chapters.length ?? book.chapters.length)) throw new Error('原文件页数与保存的书籍索引不一致；历史记录保留，请核对来源。');
        setDocument(pdf);
      } catch (e) { if (!disposed) setDocumentError(`PDF 原页加载失败：${(e as Error).message}`); }
    })();
    return () => { disposed = true; void loading?.destroy().catch(() => undefined); };
  }, [book.id, book.version, active, attempt]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let render: ReturnType<import('pdfjs-dist').PDFPageProxy['render']> | undefined;
    let textLayer: TextLayer | undefined;
    let page: import('pdfjs-dist').PDFPageProxy | undefined;
    setData(null); setRendering(true); setError(''); setWarning('');
    callbacks.current.onState({ number, ready: false, book: null, reference: null, anchor: null, warning: '', error: documentError });
    if (!document || !width || !active || !canvas.current || !layer.current) return;
    const canvasElement = canvas.current, textElement = layer.current;
    textElement.replaceChildren();
    void (async () => {
      try {
        const [loaded, snapshot, pdfjs] = await Promise.all([document.getPage(number), getPdfPage(book.id, number, controller.signal), import('pdfjs-dist')]);
        page = loaded;
        if (disposed) { loaded.cleanup(); return; }
        if (snapshot.version !== book.version) throw new Error('当前页来源版本已失效。');
        const base = loaded.getViewport({ scale: 1 });
        const scale = Math.max(.05, (width - 24) / base.width) * zoom;
        const viewport = loaded.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
        canvasElement.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvasElement.height = Math.max(1, Math.floor(viewport.height * ratio));
        setSize({ width: viewport.width, height: viewport.height });
        const context = canvasElement.getContext('2d');
        if (!context) throw new Error('浏览器无法创建 PDF 画布。');
        render = loaded.render({ canvas: canvasElement, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await render.promise;
        if (disposed) return;
        const content = await loaded.getTextContent();
        if (disposed) return;
        textElement.style.setProperty('--scale-factor', String(scale));
        textElement.style.setProperty('--total-scale-factor', String(scale * loaded.userUnit));
        textElement.style.setProperty('--user-unit', String(loaded.userUnit));
        textElement.style.setProperty('--scale-round-x', '1px'); textElement.style.setProperty('--scale-round-y', '1px');
        textLayer = new pdfjs.TextLayer({ textContentSource: content, container: textElement, viewport });
        await textLayer.render();
        if (disposed) return;
        const chapter = snapshot.chapters[0]!;
        const first = chapter.paragraphs[0], last = chapter.paragraphs.at(-1);
        const anchor = first ? { bookId: book.id, version: book.version, start: { chapterId: chapter.id, paragraphId: first.id, offset: 0 }, end: { chapterId: chapter.id, paragraphId: first.id, offset: first.text.length }, text: first.text } : null;
        let raw = '';
        const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item);
        const ranges = items.map(item => { const start = raw.length; raw += item.str + (item.hasEOL ? '\n' : ''); return { item, start, end: start + item.str.length }; });
        const scanned = !raw.trim();
        const map = scanned ? null : mapPdfText(raw, chapter.id, chapter.paragraphs);
        const divs = [...textElement.querySelectorAll<HTMLElement>('span')].filter(span => !span.querySelector('span'));
        const nonempty = ranges.filter(r => r.item.str.length > 0);
        const matches = map && divs.length === nonempty.length && divs.every((div, i) => div.textContent === nonempty[i]!.item.str);
        const layerData: LayerData | null = matches && map ? { map, divs: divs.map((element, i) => ({ element, start: nonempty[i]!.start, end: nonempty[i]!.end })), book: snapshot } : null;
        setData(layerData);
        const start = anchor?.start, end = last ? { chapterId: chapter.id, paragraphId: last.id, offset: last.text.length } : null;
        const text = start && end ? referenceText(snapshot, start, end) : '';
        const reference = layerData && start && end && text.length <= 16000 ? { bookId: book.id, version: book.version, start, end, text } : null;
        const message = scanned ? '本页没有可提取文字：可阅读原页；新导入页可添加页书签与位置笔记。选字、划线、文字引用和书伴读页需要文字层，本版本不提供 OCR。'
          : !layerData ? '本页文字层无法精确映射到历史正文。可复制文字，原有摘录与笔记保留；已禁用新划线、文字引用和书伴读页。'
          : !reference ? '本页文字超过书伴单页 16000 字符限制。可阅读、选字、划线和写笔记；本页书伴读页不可用。' : '';
        setWarning(message); setRendering(false);
        callbacks.current.onState({ number, ready: true, book: snapshot, reference, anchor, warning: message, error: '' });
        if (host.current) { host.current.scrollLeft = scrollRef.current.x * viewport.width; host.current.scrollTop = scrollRef.current.y * viewport.height; }
      } catch (e) {
        if (!disposed) { const message = `PDF 当前页加载失败：${(e as Error).message}`; setError(message); setRendering(false); callbacks.current.onState({ number, ready: false, book: null, reference: null, anchor: null, warning: '', error: message }); }
      }
    })();
    return () => { disposed = true; controller.abort(); render?.cancel(); textLayer?.cancel(); void render?.promise.catch(() => undefined).then(() => page?.cleanup()); };
  }, [document, documentError, number, width, zoom, active, book.id, book.version]);
  useEffect(() => {
    const changed = () => {
      const selected = window.getSelection();
      if (data && layer.current && selected?.anchorNode && layer.current.contains(selected.anchorNode)) callbacks.current.onSelection(capturePdfSelection(data, layer.current));
    };
    window.document.addEventListener('selectionchange', changed);
    return () => window.document.removeEventListener('selectionchange', changed);
  }, [data]);
  useLayoutEffect(() => {
    if (!rendering && host.current && size.width) {
      host.current.scrollLeft = scroll.x * size.width;
      host.current.scrollTop = scroll.y * size.height;
    }
  }, [scroll.x, scroll.y, rendering, size.width, size.height]);
  useLayoutEffect(() => {
    const overlay = marks.current, textElement = layer.current;
    if (!overlay || !textElement) return;
    overlay.replaceChildren();
    if (!data) return;
    const chapterId = data.map.chapterId;
    const pageStart = positionRank(book, { chapterId, paragraphId: data.map.paragraphs[0]!.id, offset: 0 });
    const last = data.map.paragraphs.at(-1)!;
    const pageEnd = positionRank(book, { chapterId, paragraphId: last.id, offset: last.text.length });
    const sources = [...records.filter(r => r.kind === 'highlight').map(r => ({ reference: r.reference, noteId: '', located: false })),
      ...notes.flatMap(n => n.reference ? [{ reference: n.reference, noteId: n.id, located: false }] : []),
      ...(located ? [{ reference: located, noteId: '', located: true }] : [])];
    const box = textElement.getBoundingClientRect();
    let focus: HTMLElement | null = null;
    for (const source of sources) {
      if (!validBookReference(book, source.reference) || positionRank(book, source.reference.end) <= pageStart || positionRank(book, source.reference.start) >= pageEnd) continue;
      for (const raw of pdfRawRanges(data.map, source.reference.start, source.reference.end)) for (const div of data.divs) {
        const start = Math.max(raw.start, div.start), end = Math.min(raw.end, div.end);
        if (end <= start) continue;
        const range = window.document.createRange(); range.setStart(...textEndpoint(div.element, start - div.start)); range.setEnd(...textEndpoint(div.element, end - div.start));
        for (const rect of range.getClientRects()) {
          const mark = window.document.createElement('span');
          mark.className = source.located ? 'reading-pdf-located' : source.noteId ? 'reading-pdf-note-mark' : 'reading-pdf-highlight';
          Object.assign(mark.style, { left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
          overlay.append(mark);
          if (source.noteId) {
            const button = window.document.createElement('button'); button.className = 'reading-pdf-note-button';
            button.setAttribute('aria-label', '查看此处笔记'); button.title = '查看此处笔记'; button.textContent = '笔';
            Object.assign(button.style, { left: `${rect.right - box.left}px`, top: `${rect.top - box.top}px`, width: '18px', height: '18px' });
            button.onclick = () => callbacks.current.onNote(source.noteId); overlay.append(button);
          }
          if (source.located && !focus) focus = mark;
        }
      }
    }
    function positionRect(position: BookPosition) {
      if (position.chapterId !== chapterId) return null;
      const span = data!.map.spans.find(s => s.paragraphId === position.paragraphId && position.offset >= s.offset && position.offset <= s.offset + s.rawEnd - s.rawStart);
      if (!span) return null;
      const raw = span.rawStart + position.offset - span.offset;
      const div = data!.divs.find(d => d.start <= raw && d.end >= raw);
      if (!div) return null;
      const range = window.document.createRange(); range.setStart(...textEndpoint(div.element, raw - div.start)); range.collapse(true);
      return range.getClientRects()[0] ?? div.element.getBoundingClientRect();
    }
    for (const note of notes.filter(n => !n.reference)) {
      const location = readingNoteLocation(note);
      if (location.bookId !== book.id || location.version !== book.version) continue;
      const rect = positionRect(location.position); if (!rect) continue;
      const button = window.document.createElement('button'); button.className = 'reading-pdf-note-button'; button.textContent = '笔';
      button.setAttribute('aria-label', '查看此处笔记'); button.title = '查看此处笔记';
      Object.assign(button.style, { left: `${rect.right - box.left}px`, top: `${rect.top - box.top}px`, width: '18px', height: '18px' });
      button.onclick = () => callbacks.current.onNote(note.id); overlay.append(button);
    }
    if (!focus && locatePosition) {
      const rect = positionRect(locatePosition);
      if (rect) {
        const marker = window.document.createElement('span');
        Object.assign(marker.style, { left: `${rect.left - box.left}px`, top: `${rect.top - box.top}px`, width: '1px', height: `${rect.height}px` });
        overlay.append(marker); focus = marker;
      }
    }
    focus?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [data, records, notes, located, book, locatePosition]);
  return <div className="reading-pdf-container">
    {(documentError || error) && <div className="reading-pdf-feedback" role="alert">{documentError || error}<button className="reading-command" onClick={() => setAttempt(n => n + 1)}>重试原页加载</button></div>}
    {rendering && !documentError && !error && <div className="reading-pdf-feedback" role="status">正在读取第 {number} 原始页…</div>}
    {warning && <div className="reading-pdf-warning" role="status">{warning}</div>}
    <div ref={host} className="reading-pdf-viewport" tabIndex={0} aria-label={`PDF 原始第 ${number} 页`} onCopy={event => { if (data && layer.current) { const selected = capturePdfSelection(data, layer.current); if (selected) { event.preventDefault(); event.clipboardData.setData('text/plain', selected.reference.text); } } }} onPointerDown={() => callbacks.current.onSelection(null)} onScroll={() => {
      if (!rendering && size.width && host.current) callbacks.current.onScroll({ x: host.current.scrollLeft / size.width, y: host.current.scrollTop / size.height });
    }}>
      <div className="reading-pdf-sheet" style={{ width: size.width || undefined, height: size.height || undefined, visibility: rendering || error || documentError ? 'hidden' : 'visible' } as CSSProperties}>
        <canvas ref={canvas} style={{ width: size.width, height: size.height }} aria-label={`第 ${number} 页原始版式`} />
        <div ref={layer} className="textLayer reading-pdf-text-layer" />
        <div ref={marks} className="reading-pdf-marks" />
      </div>
    </div>
  </div>;
}
