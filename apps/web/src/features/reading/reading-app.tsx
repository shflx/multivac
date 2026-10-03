import { useEffect, useRef, useState } from 'react';
import { Upload, BookOpen } from 'lucide-react';
import { BOOK_SOURCE_LIMIT_BYTES, type Book, type BookSummary, type ImportBook } from '@multivac/contracts';
import { getBook, importBook, listBooks } from '../../data/reading-api.js';
import { ManagementPageActions } from '../../app/management-layout.js';
import './reading.css';
import { ReadingReader } from './reading-reader.js';

export function ReadingApp({ active }: { active: boolean }) {
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
    if (!restored.current) {
      restored.current = true;
      try { const id = localStorage.getItem('multivac.reading.active'); if (id && value.books.some(b => b.id === id)) void select(id); }
      catch { setError('本机无法恢复上次选择的书籍。'); }
    }
  });
  useEffect(() => { if (active) void refresh().catch(e => setError((e as Error).message)); }, [active]);
  async function select(id: string) {
    const token = ++request.current;
    setError('');
    try { const next = await getBook(id); if (token === request.current) { setBook(next); localStorage.setItem('multivac.reading.active', id); } }
    catch (e) { if (token === request.current) setError((e as Error).message); }
  }
  async function submit() {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const extension = file.name.split('.').at(-1)?.toLowerCase();
      if (extension !== 'txt' && extension !== 'md') throw new Error('请选择 TXT 或 Markdown 文件。');
      if (file.size > BOOK_SOURCE_LIMIT_BYTES) throw new Error('书籍超过 1 MiB 限制。');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      pending.current ??= { commandId: crypto.randomUUID(), title: title.trim() || file.name.replace(/\.[^.]+$/u, ''), author: author.trim(), format: extension, text };
      const saved = await importBook(pending.current);
      await refresh(); ++request.current; setBook(saved); localStorage.setItem('multivac.reading.active', saved.id); setImportOpen(false); pending.current = null;
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="reading-app">
    <ManagementPageActions><button className="reading-command" onClick={() => setImportOpen(v => !v)}><Upload size={16} />导入书籍</button></ManagementPageActions>
    {error && <p role="alert">{error}</p>}
    {importOpen && <form className="reading-import" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label>文件（TXT / Markdown，最多 1 MiB）<input disabled={busy} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={event => { setFile(event.target.files?.[0] ?? null); pending.current = null; }} /></label>
      <label>书名<input disabled={busy} value={title} onChange={event => { setTitle(event.target.value); pending.current = null; }} maxLength={200} /></label>
      <label>作者<input disabled={busy} value={author} onChange={event => { setAuthor(event.target.value); pending.current = null; }} maxLength={200} /></label>
      <button className="reading-command" type="submit" disabled={!file || busy}><Upload size={16} />{busy ? '导入中' : '导入'}</button>
    </form>}
    <div className="reading-library">
      <nav aria-label="书架">{!books.length && <p>书架为空</p>}{books.map(item => <button key={item.id} aria-current={item.id === book?.id ? 'true' : undefined} onClick={() => void select(item.id)}><BookOpen size={18} /><span><strong>{item.title}</strong><small>{item.author || '作者未注明'} · {item.paragraphCount} 段</small></span></button>)}</nav>
      <div className="reading-content">{book ? <ReadingReader key={book.id} book={book} active={active} /> : <p>选择书籍</p>}</div>
    </div>
  </section>;
}
