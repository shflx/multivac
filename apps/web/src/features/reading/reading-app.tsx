import { useEffect, useRef, useState } from 'react';
import { Upload, BookOpen } from 'lucide-react';
import { BOOK_SOURCE_LIMIT_BYTES, BOOK_BINARY_LIMIT_BYTES, type AssistantBookQuote, type BookReference, type BookPosition, type Book, type BookSummary, type ImportBook } from '@multivac/contracts';
import { getBook, importBook, listBooks } from '../../data/reading-api.js';
import './reading.css';
import { ReadingReader } from './reading-reader.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function ReadingApp({ active, request: navigationRequest, onHandover, onReport }: { active: boolean; request?: { id: number; bookId: string; sessionId?: string; position?: BookPosition; version?: string } | null; onHandover: (quote: AssistantBookQuote) => void; onReport: (report: { title: string; reference: BookReference; discussionId: string | null } | null) => void }) {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const request = useRef(0);
  const pending = useRef<ImportBook | null>(null);
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
    try { const next = await getBook(id); if (token === request.current) { setBook(current => current?.id === next.id && current.version === next.version ? current : next); localStorage.setItem('multivac.reading.active', id); } }
    catch (e) { if (token === request.current) setError((e as Error).message); }
  }
  async function submit() {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (!['txt', 'md', 'pdf', 'epub'].includes(extension ?? '')) throw new Error('请选择 TXT、Markdown、PDF 或 EPUB 文件。');
      if (!pending.current) {
        const metadata = { commandId: crypto.randomUUID(), title: title.trim() || file.name.replace(/\.[^.]+$/u, ''), author: author.trim() };
        if (extension === 'pdf' || extension === 'epub') {
          if (file.size > BOOK_BINARY_LIMIT_BYTES) throw new Error('PDF、EPUB 文件最多 20 MiB。');
          const bytes = new Uint8Array(await file.arrayBuffer());
          // 分块转换，避免大文件展开参数时超过调用栈上限。
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          pending.current = { ...metadata, format: extension, dataBase64: btoa(binary) };
        } else {
          if (file.size > BOOK_SOURCE_LIMIT_BYTES) throw new Error('TXT、Markdown 文件最多 1 MiB。');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          pending.current = { ...metadata, format: extension as 'txt' | 'md', text };
        }
      }
      const saved = await importBook(pending.current);
      await refresh(); ++request.current; setBook(saved); localStorage.setItem('multivac.reading.active', saved.id); setImportOpen(false); pending.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const shelf = <nav aria-label="书架">{!books.length && <p>书架为空</p>}{books.map(item => <button key={item.id} aria-current={item.id === book?.id ? 'true' : undefined} onClick={() => void select(item.id)}><BookOpen size={18} /><span><strong>{item.title}</strong><small>{item.author || '作者未注明'} · {item.paragraphCount} 段</small></span></button>)}</nav>;
  return <section className="reading-app">
    {!book && <header className="reading-shelf-heading"><h2>书架</h2><button className="reading-command" onClick={() => setImportOpen(v => !v)}><Upload size={16} />导入书籍</button></header>}
    {error && <p role="alert">{error}</p>}
    {importOpen && <form className="reading-import" aria-label="导入书籍" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>文件（TXT / Markdown ≤ 1 MiB，PDF / EPUB ≤ 20 MiB）<input disabled={busy} type="file" accept=".txt,.md,.pdf,.epub,text/plain,text/markdown,application/pdf,application/epub+zip" onChange={event => { setFile(event.target.files?.[0] ?? null); pending.current = null; }} /></label>
      <small>PDF、EPUB 提取文字后阅读；扫描 PDF 暂不支持 OCR。</small>
      <label>书名<input disabled={busy} value={title} onChange={event => { setTitle(event.target.value); pending.current = null; }} maxLength={200} /></label>
      <label>作者<input disabled={busy} value={author} onChange={event => { setAuthor(event.target.value); pending.current = null; }} maxLength={200} /></label>
      <button className="reading-command" type="submit" disabled={!file || busy}><Upload size={16} />{busy ? '导入中' : '导入'}</button>
      <button className="reading-command" type="button" disabled={busy} onClick={() => setImportOpen(false)}>取消</button>
    </form>}
    <div className="reading-content">{book ? <ReadingReader key={book.id} book={book} shelf={shelf} onImport={() => setImportOpen(true)} active={active} onHandover={onHandover} onReport={onReport} discussionRequest={navigationRequest?.bookId === book.id && navigationRequest.sessionId ? { id: navigationRequest.id, sessionId: navigationRequest.sessionId } : null} positionRequest={navigationRequest?.bookId === book.id && navigationRequest.position ? { id: navigationRequest.id, position: navigationRequest.position, version: navigationRequest.version ?? '' } : null} /> : <div className="reading-library">{shelf}</div>}</div>
  </section>;
}
