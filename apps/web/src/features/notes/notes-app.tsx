import { useEffect, useRef, useState } from 'react';
import { NotebookPen, Plus, FileText } from 'lucide-react';
import { Check } from 'typebox/value';
import { CreateNoteSchema, type CreateNote, type Note, type NoteSummary } from '@multivac/contracts';
import { createNote, getNote, listNotes } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { NoteAssistantWithSuggestions } from './note-suggestions.js';
import { NoteEditor } from './note-editor.js';
import './notes.css';

export function NotesApp({ active }: { active: boolean }) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [opened, setOpened] = useState<Map<string, Note>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(() => { try { return sessionStorage.getItem('multivac:active-note'); } catch { return null; } });
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const sequence = useRef(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const mounted = useRef(true);
  const createRequest = useRef<CreateNote | null>(null);
  const createBusy = useRef(false);

  function choose(id: string) {
    setSelected(id); selectedRef.current = id;
    try { sessionStorage.setItem('multivac:active-note', id); } catch {}
    void getNote(id).then(note => {
      if (mounted.current) setOpened(previous => new Map(previous).set(id, previous.get(id) ?? note));
    }).catch(e => { if (mounted.current && selectedRef.current === id) setError((e as Error).message); });
  }
  async function load() {
    const ticket = ++sequence.current;
    try {
      const result = await listNotes();
      if (!mounted.current || ticket !== sequence.current) return;
      setNotes(result.notes); setError('');
      const id = result.notes.find(n => n.id === selectedRef.current)?.id ?? result.notes[0]?.id;
      if (id) choose(id);
    } catch (e) { if (mounted.current && ticket === sequence.current) setError((e as Error).message); }
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
  useWorkbenchEvents(event => { if (event.type === 'notes.changed' || event.type === 'workbench.connected') void load(); });

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
      setOpened(previous => new Map(previous).set(note.id, note));
      choose(note.id); await load();
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { createBusy.current = false; if (mounted.current) setCreating(false); }
  }
  function saved(note: Note) {
    setNotes(previous => previous ? previous.map(item => item.id === note.id && note.revision >= item.revision ? (({ body: _body, ...summary }) => summary)(note) : item) : previous);
  }
  return <div className="notes-app"><div className="notes-layout">
    <aside className="notes-library" aria-label="笔记库">
      <header>
        <div className="notes-library-heading"><NotebookPen size={18} aria-hidden="true" /><strong>笔记库</strong>{notes && <small>{notes.length}</small>}</div>
        <button type="button" aria-label="新建笔记" title="新建笔记" disabled={creating} onClick={() => void create()}><Plus size={17} /></button>
      </header>
      <div className="notes-library-list">
        {notes === null ? <p>正在读取笔记库…</p> : notes.length === 0 ? <p>还没有笔记，点击右上角开始记录。</p> : notes.map(note => <button type="button" key={note.id} aria-current={selected === note.id ? 'true' : undefined} title={note.title || '未命名笔记'} onClick={() => choose(note.id)}>
          <span className="notes-library-icon"><FileText size={16} aria-hidden="true" /></span>
          <span className="notes-library-copy"><strong>{note.title || '未命名笔记'}</strong><time dateTime={note.updatedAt} title={new Date(note.updatedAt).toLocaleString()}>{new Date(note.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
        </button>)}
      </div>
    </aside>
    <div className="notes-main">
      {error && <div className="notes-error" role="alert">{error}<button type="button" onClick={() => void (createRequest.current ? create() : load())}>重试</button></div>}
      {selected && !opened.has(selected) && <p className="notes-hint">正在读取笔记…</p>}
      {!selected && notes !== null && <div className="notes-empty"><span className="notes-empty-icon"><NotebookPen size={30} aria-hidden="true" /></span><h2>开始记录你的想法</h2><p>写下笔记，与梳理助手一起整理。</p><button type="button" onClick={() => void create()} disabled={creating}><Plus size={15} />创建第一篇笔记</button></div>}
      {[...opened].map(([id, note]) => <div className="notes-open-document" key={id} hidden={selected !== id}><NoteEditor initial={note} onSaved={saved} companion={bridge => <NoteAssistantWithSuggestions bridge={bridge} />} /></div>)}
    </div>
  </div></div>;
}
