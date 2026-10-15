import { useEffect, useRef, useState } from 'react';
import { Plus, Search, X, NotebookPen } from 'lucide-react';
import { Check } from 'typebox/value';
import { CreateNoteSchema, type CreateNote, type Note, type NoteSummary } from '@multivac/contracts';
import { createNote, getNote, listNotes } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { NoteAssistant } from './note-assistant.js';
import { NoteEditor } from './note-editor.js';
import { clearDeletedNoteStorage } from './note-draft.js';
import './notes.css';

export function NotesApp({ active }: { active: boolean }) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [opened, setOpened] = useState<Map<string, Note>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(() => { try { return sessionStorage.getItem('multivac:active-note'); } catch { return null; } });
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteRoot, setDeleteRoot] = useState<HTMLSpanElement | null>(null);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const matching = notes?.filter(note => note.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const openedRef = useRef(opened); openedRef.current = opened;
  const opening = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const loading = useRef<Promise<void> | null>(null);
  const reloadNeeded = useRef(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const mounted = useRef(true);
  const createRequest = useRef<CreateNote | null>(null);
  const createBusy = useRef(false);

  function forget(id: string) {
    if (removed.current.has(id)) return;
    removed.current.add(id);
    const next = new Map(openedRef.current); next.delete(id);
    openedRef.current = next; setOpened(next);
    setNotes(previous => previous?.filter(note => note.id !== id) ?? null);
    if (selectedRef.current === id) {
      selectedRef.current = null; setSelected(null);
      try { sessionStorage.removeItem('multivac:active-note'); } catch { /* 后续仍按服务端列表核对。 */ }
    }
    try { clearDeletedNoteStorage(id); }
    catch { setError('笔记已删除，本机草稿清理失败，请检查浏览器存储。'); }
  }
  function remember(note: Note) {
    if (removed.current.has(note.id)) return;
    const previous = openedRef.current.get(note.id);
    if (previous && previous.revision >= note.revision) return;
    const next = new Map(openedRef.current).set(note.id, note);
    openedRef.current = next; setOpened(next);
  }
  function choose(id: string) {
    if (removed.current.has(id)) return;
    if (selectedRef.current !== id) {
      setSelected(id); selectedRef.current = id;
      try { sessionStorage.setItem('multivac:active-note', id); } catch {}
    }
    // 已挂载的编辑器保留草稿并按摘要版本核对，不在每次刷新列表时重读正文。
    if (openedRef.current.has(id) || opening.current.has(id)) return;
    opening.current.add(id);
    void getNote(id).then(note => { if (mounted.current) remember(note); })
      .catch(e => { if (mounted.current && selectedRef.current === id) setError((e as Error).message); })
      .finally(() => opening.current.delete(id));
  }
  function load(invalidate = false): Promise<void> {
    if (loading.current) {
      if (invalidate) reloadNeeded.current = true;
      return loading.current;
    }
    const request = (async () => {
      do {
        reloadNeeded.current = false;
        try {
          const result = await listNotes();
          if (!mounted.current) return;
          if (reloadNeeded.current) continue;
          const available = result.notes.filter(note => !removed.current.has(note.id));
          setError('');
          const present = new Set(available.map(note => note.id));
          for (const id of new Set([...openedRef.current.keys(), ...opening.current, ...(selectedRef.current ? [selectedRef.current] : [])])) if (!present.has(id)) forget(id);
          setNotes(available.map(summary => {
            const known = openedRef.current.get(summary.id);
            if (!known || known.revision <= summary.revision) return summary;
            const { body: _body, ...latest } = known; return latest;
          }));
          const id = available.find(n => n.id === selectedRef.current)?.id ?? available[0]?.id;
          if (id) choose(id);
        } catch (e) { if (mounted.current) setError((e as Error).message); }
      } while (reloadNeeded.current && mounted.current);
    })().finally(() => { loading.current = null; });
    loading.current = request; return request;
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem('multivac:create-note');
      if (raw) { const value: unknown = JSON.parse(raw); if (Check(CreateNoteSchema, value)) { createRequest.current = value; setError('新建笔记结果待核对，请重试原请求。'); } }
    } catch { setError('新建命令的本机记录无法读取，请检查浏览器存储。'); }
    void load(); return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (active) void load(); }, [active]);
  useWorkbenchEvents(event => { if (event.type === 'notes.changed' || event.type === 'workbench.connected') void load(true); });

  async function create() {
    if (createBusy.current) return;
    createBusy.current = true; setCreating(true); setError('');
    try {
      const request = createRequest.current ?? { id: newCommandId(), commandId: newCommandId(), title: '未命名笔记', body: '' };
      // 先保存原命令，刷新或连接中断后沿用同一身份重试。
      sessionStorage.setItem('multivac:create-note', JSON.stringify(request)); createRequest.current = request;
      const note = await createNote(request);
      sessionStorage.removeItem('multivac:create-note'); createRequest.current = null;
      if (!mounted.current) return;
      remember(note);
      setSearch(''); choose(note.id); await load(true);
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { createBusy.current = false; if (mounted.current) setCreating(false); }
  }
  function saved(note: Note) {
    remember(note);
    setNotes(previous => previous ? previous.map(item => item.id === note.id && note.revision >= item.revision ? (({ body: _body, ...summary }) => summary)(note) : item) : previous);
  }
  return <div className="notes-app"><div className="notes-layout">
    <aside className="notes-library" aria-label="笔记库">
      <header>
        <div className="notes-library-heading"><strong>全部笔记</strong>{notes && <small>{search.trim() ? `${matching?.length} / ${notes.length}` : notes.length}</small>}</div>
        <button type="button" aria-label="新建笔记" title="新建笔记" disabled={creating} onClick={() => void create()}><Plus size={17} /></button>
      </header>
      <div className="notes-library-search"><Search size={14} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="搜索笔记标题" placeholder="搜索笔记标题" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); setSearch(''); } }} />{search && <button type="button" aria-label="清除笔记搜索" onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={13} /></button>}</div>
      <div className="notes-library-list">
        {notes === null ? <p>正在读取笔记库…</p> : notes.length === 0 ? <p>还没有笔记，点击右上角开始记录。</p> : matching?.length === 0 ? <p>没有匹配的笔记</p> : matching?.map(note => <div className="notes-library-item" data-selected={selected === note.id} key={note.id}><button type="button" className="note-list-open" aria-current={selected === note.id ? 'true' : undefined} title={note.title || '未命名笔记'} onClick={() => choose(note.id)}>
          <span className="notes-library-copy"><strong>{note.title || '未命名笔记'}</strong><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>{new Date(note.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
        </button>{selected === note.id && <span className="note-list-actions" ref={setDeleteRoot} />}</div>)}
      </div>
    </aside>
    <div className="notes-main">
      {error && <div className="notes-error" role="alert">{error}<button type="button" onClick={() => void (createRequest.current ? create() : load())}>重试</button></div>}
      {selected && !opened.has(selected) && <p className="notes-hint">正在读取笔记…</p>}
      {!selected && notes !== null && <div className="notes-empty"><span className="notes-empty-icon"><NotebookPen size={30} aria-hidden="true" /></span><h2>开始记录你的想法</h2><p>写下笔记，与梳理助手一起整理。</p><button type="button" onClick={() => void create()} disabled={creating}><Plus size={15} />创建第一篇笔记</button></div>}
      {[...opened].map(([id, note]) => <div className="notes-open-document" key={id} hidden={selected !== id}><NoteEditor initial={note} latestRevision={notes?.find(summary => summary.id === id)?.revision ?? note.revision} active={active && selected === id} onSaved={saved} deleteRoot={selected === id ? deleteRoot : null} onDeleted={() => { forget(id); void load(true); }} companion={bridge => <NoteAssistant bridge={bridge} />} /></div>)}
    </div>
  </div></div>;
}
