import { getCachedBookWindow } from './reading-window-cache.js';
import { ReadingImportDialog } from './reading-import-dialog.js';
import { indexedPosition, type ReadingBook } from './reading-book.js';
import { useEffect, useRef, useState } from 'react';
import { Upload, BookOpen } from 'lucide-react';
import { BOOK_SOURCE_LIMIT_BYTES, type AssistantBookQuote, type BookReference, type BookPosition, type BookSummary, type BookUpload, type ImportBook } from '@multivac/contracts';
import { getBookIndex, uploadBook, importBook, listBooks } from '../../data/reading-api.js';
import './reading.css';
import { ReadingReader } from './reading-reader.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function ReadingApp({ active, request: navigationRequest, onHandover, onReport, onManageModels }: { active: boolean; request?: { id: number; bookId: string; sessionId?: string; position?: BookPosition; version?: string } | null; onHandover: (quote: AssistantBookQuote) => void; onManageModels: () => void; onReport: (report: { title: string; reference: BookReference; discussionId: string | null } | null) => void }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [book, setBook] = useState<ReadingBook | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const request = useRef(0);
  const pending = useRef<ImportBook | null>(null);
  const pendingUpload = useRef<BookUpload | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const restored = useRef(false);
  const refresh = () => listBooks().then(value => {
    setBooks(value.books);
    if (!restored.current && !navigationRequest) {
      restored.current = true;
      try { const id = localStorage.getItem('multivac.reading.active'); if (id && value.books.some(b => b.id === id)) void select(id); }
      catch { setError('本机无法恢复上次选择的书籍。'); }
    }
  });
  useEffect(() => { if (active) void refresh().catch(e => setError((e as Error).message)); }, [active]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId && !books.some(b => b.id === event.bookId)) void refresh().catch(e => setError((e as Error).message)); });
  useEffect(() => { if (navigationRequest) { restored.current = true; void select(navigationRequest.bookId); } }, [navigationRequest?.id]);
  async function select(id: string) {
    const token = ++request.current;
    setError('');
    setLoadingContent(true);
    try {
      const index = await getBookIndex(id);
      let position = navigationRequest?.bookId === id && navigationRequest.version === index.version ? navigationRequest.position : undefined;
      if (!position) {
        try { const scene = JSON.parse(localStorage.getItem(`multivac.reading.scene.${id}`) ?? 'null'); if (scene?.version === index.version) position = scene.position; } catch { /* 使用首段。 */ }
      }
      const block = position ? indexedPosition(index, position)?.block ?? 0 : 0;
      const next = await getCachedBookWindow(id, block);
      if (token === request.current) { setBook({ ...next.book, index, block }); localStorage.setItem('multivac.reading.active', id); }
    } catch (e) { if (token === request.current) setError((e as Error).message); }
    finally { if (token === request.current) setLoadingContent(false); }
  }
  async function loadPosition(position: BookPosition) {
    if (!book?.index) return false;
    const block = indexedPosition(book.index, position)?.block;
    if (block === undefined) { setError('原文位置已失效。'); return false; }
    if (block === book.block) return true;
    const token = ++request.current; setLoadingContent(true); setError('');
    try {
      const next = await getCachedBookWindow(book.id, block);
      if (token !== request.current) return false;
      setBook({ ...next.book, index: book.index, block }); return true;
    } catch (e) { if (token === request.current) setError((e as Error).message); return false; }
    finally { if (token === request.current) setLoadingContent(false); }
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true); setImportError('');
    try {
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (!['txt', 'md', 'pdf', 'epub'].includes(extension ?? '')) throw new Error('请选择 TXT、Markdown、PDF 或 EPUB 文件。');
      const metadata = { commandId: crypto.randomUUID(), title: title.trim() || file.name.replace(/\.[^.]+$/u, ''), author: author.trim() };
      let saved: BookSummary;
      if (extension === 'pdf' || extension === 'epub') {
        pendingUpload.current ??= { ...metadata, format: extension };
        uploadController.current = new AbortController();
        saved = await uploadBook(pendingUpload.current, file, uploadController.current.signal);
      } else {
        if (!pending.current) {
          if (file.size > BOOK_SOURCE_LIMIT_BYTES) throw new Error('TXT、Markdown 文件最多 1 MiB。');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          pending.current = { ...metadata, format: extension as 'txt' | 'md', text };
        }
        saved = await importBook(pending.current);
      }
      await refresh(); await select(saved.id); setImportOpen(false); setFile(null); setTitle(''); setAuthor(''); pending.current = null; pendingUpload.current = null;
    } catch (e) { setImportError((e as Error).name === 'AbortError' ? '已停止导入请求，可从书架核对已完成的结果。' : (e as Error).message); }
    finally { uploadController.current = null; setBusy(false); }
  }
  const shelf = <nav aria-label="书架">{!books.length && <p>书架为空</p>}{books.map(item => <button key={item.id} aria-current={item.id === book?.id ? 'true' : undefined} onClick={() => void select(item.id)}><BookOpen size={18} /><span><strong>{item.title}</strong><small>{item.author || '作者未注明'} · {item.format.toUpperCase()}</small></span></button>)}</nav>;
  return <section className="reading-app">
    {!book && <header className="reading-shelf-heading"><h2>书架</h2><button className="reading-command" onClick={event => { event.currentTarget.focus({ preventScroll: true }); setImportError(''); setImportOpen(true); }}><Upload size={16} />导入书籍</button></header>}
    {error && <p className={book ? 'reading-load-error' : undefined} role="alert">{error}</p>}
    {active && importOpen && <ReadingImportDialog file={file} title={title} author={author} busy={busy} cancellable={Boolean(uploadController.current)} error={importError}
      onFile={next => {
        const previousName = file?.name.replace(/\.[^.]+$/u, '').slice(0, 200) ?? '';
        setFile(next); if (!title.trim() || title === previousName) setTitle(next.name.replace(/\.[^.]+$/u, '').slice(0, 200));
        pending.current = null; pendingUpload.current = null; setImportError('');
      }}
      onTitle={value => { setTitle(value); pending.current = null; pendingUpload.current = null; }}
      onAuthor={value => { setAuthor(value); pending.current = null; pendingUpload.current = null; }}
      onSubmit={() => void submit()} onCancel={() => { if (busy) uploadController.current?.abort(); else setImportOpen(false); }} />}

    <div className="reading-content">{book ? <ReadingReader onManageModels={onManageModels} key={book.id} book={book} loadingContent={loadingContent} loadPosition={loadPosition} shelf={shelf} onImport={() => { setImportError(''); setImportOpen(true); }} active={active} onHandover={onHandover} onReport={onReport} discussionRequest={navigationRequest?.bookId === book.id && navigationRequest.sessionId ? { id: navigationRequest.id, sessionId: navigationRequest.sessionId } : null} positionRequest={navigationRequest?.bookId === book.id && navigationRequest.position ? { id: navigationRequest.id, position: navigationRequest.position, version: navigationRequest.version ?? '' } : null} /> : <div className="reading-library">{shelf}</div>}</div>
  </section>;
}
