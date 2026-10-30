import { onNoteAccessChange, unlockedNote, hasNoteAccess, protectedNote, markProtected, markOrdinary, forgetNoteAccess, noteUserActivity } from '../../data/note-access.js';
import { clearNoteVaultMemory, protectionMarker, restoreOwnOrdinaryVault } from './note-vault.js';
import { LockedNote, convertingNotes } from './note-security.js';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, X, NotebookPen } from 'lucide-react';
import { Check } from 'typebox/value';
import { CreateNoteSchema, type CreateNote, type Note, type NoteSummary } from '@multivac/contracts';
import { createNote, getNote, listNotes } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { NoteAssistant } from './note-assistant.js';
import { NoteEditor } from './note-editor.js';
import { clearDeletedNoteStorage } from './note-draft.js';
import { NotesList } from './notes-list.js';
import { reuseNoteSummaries } from './note-summary-cache.js';
import './notes.css';

const renderAssistant: NonNullable<Parameters<typeof NoteEditor>[0]['companion']> = bridge => <NoteAssistant bridge={bridge} />;

// 搜索和分页不进入文档宿主；保留挂载现场，同时只响应本篇内容、版本与可见状态变化。
const OpenNote = memo(function OpenNote({ note, latestRevision, active, selected, deleteRoot, onSaved, onDeleted }: {
  note: Note; latestRevision: number; active: boolean; selected: boolean; deleteRoot: HTMLSpanElement | null;
  onSaved(note: Note): void; onDeleted(id: string): void;
}) {
  const deleted = useCallback(() => onDeleted(note.id), [note.id, onDeleted]);
  return <div className="notes-open-document" hidden={!selected}><NoteEditor initial={note} latestRevision={latestRevision} active={active} onSaved={onSaved} deleteRoot={deleteRoot} onDeleted={deleted} companion={renderAssistant} /></div>;
});

export function NotesApp({ active }: { active: boolean }) {
  const [securityVersion, securityRender] = useState(0);
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [opened, setOpened] = useState<Map<string, Note>>(() => new Map());
  const [selected, setSelected] = useState<string | null>(() => { try { return sessionStorage.getItem('multivac:active-note'); } catch { return null; } });
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteRoot, setDeleteRoot] = useState<HTMLSpanElement | null>(null);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const searchKey = search.trim().toLocaleLowerCase();
  // 加密笔记只在当前窗口已解锁时显示真实标题，取自页面内存中已打开的正文，不写入浏览器存储。
  const displayed = useMemo(() => notes?.map(note => {
    const open = note.protection && unlockedNote(note.id) ? opened.get(note.id) : undefined;
    return open ? { ...note, title: open.title, updatedAt: open.updatedAt } : note;
  }), [notes, opened, securityVersion]);
  const searchable = useMemo(() => displayed?.map(note => ({ note, title: note.title.toLocaleLowerCase() })), [displayed]);
  const matching = useMemo(() => searchable?.filter(item => item.title.includes(searchKey)).map(item => item.note), [searchable, searchKey]);
  const revisions = useMemo(() => new Map(notes?.map(note => [note.id, note.revision])), [notes]);
  const openedRef = useRef(opened); openedRef.current = opened;
  const opening = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const loading = useRef<Promise<void> | null>(null);
  const reloadNeeded = useRef(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const mounted = useRef(true);
  const createRequest = useRef<CreateNote | null>(null);
  const createBusy = useRef(false);

  const forget = useCallback((id: string) => {
    if (removed.current.has(id)) return;
    removed.current.add(id);
    forgetNoteAccess(id);
    const next = new Map(openedRef.current); next.delete(id);
    openedRef.current = next; setOpened(next);
    setNotes(previous => previous?.filter(note => note.id !== id) ?? null);
    if (selectedRef.current === id) {
      selectedRef.current = null; setSelected(null);
      try { sessionStorage.removeItem('multivac:active-note'); } catch { /* 后续仍按服务端列表核对。 */ }
    }
    try { clearDeletedNoteStorage(id); }
    catch { setError('笔记已删除，本机草稿清理失败，请检查浏览器存储。'); }
  }, []);
  const remember = useCallback((note: Note) => {
    if (removed.current.has(note.id) || protectedNote(note.id) && !unlockedNote(note.id)) return;
    const previous = openedRef.current.get(note.id);
    if (previous && previous.revision >= note.revision) return;
    const next = new Map(openedRef.current).set(note.id, note);
    openedRef.current = next; setOpened(next);
  }, []);
  const choose = useCallback((id: string) => {
    if (removed.current.has(id)) return;
    if (selectedRef.current !== id) {
      setSelected(id); selectedRef.current = id;
      try { sessionStorage.setItem('multivac:active-note', id); } catch {}
    }
    // 已挂载的编辑器保留草稿并按摘要版本核对，不在每次刷新列表时重读正文。
    if (protectedNote(id) && !unlockedNote(id) || openedRef.current.has(id) || opening.current.has(id)) return;
    opening.current.add(id);
    void getNote(id).then(note => { if (mounted.current) remember(note); })
      .catch(e => { if (mounted.current && selectedRef.current === id) setError((e as Error).message); })
      .finally(() => opening.current.delete(id));
  }, [remember]);
  const load = useCallback((invalidate = false): Promise<void> => {
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
          const available = result.notes.filter(note => !removed.current.has(note.id)).map(note => localStorage.getItem(protectionMarker(note.id)) === 'transition' && !convertingNotes.has(note.id) ? { ...note, title: '加密笔记', protection: 'encrypting' as const } : note);
          for (const summary of available) {
            if (convertingNotes.has(summary.id)) continue;
            if (summary.protection) {
              markProtected(summary.id);
              if (!unlockedNote(summary.id) && openedRef.current.has(summary.id)) {
                const next = new Map(openedRef.current); next.delete(summary.id); openedRef.current = next; setOpened(next);
              }
            } else { markOrdinary(summary.id); restoreOwnOrdinaryVault(summary.id); }
          }
          setError('');
          const present = new Set(available.map(note => note.id));
          for (const id of new Set([...openedRef.current.keys(), ...opening.current, ...(selectedRef.current ? [selectedRef.current] : [])])) if (!present.has(id)) forget(id);
          setNotes(previous => reuseNoteSummaries(previous, available.map(summary => {
            const known = openedRef.current.get(summary.id);
            if (!known || summary.protection || known.revision <= summary.revision) return summary;
            const { body: _body, ...latest } = known; return latest;
          })));
          const id = available.find(n => n.id === selectedRef.current)?.id ?? available[0]?.id;
          if (id) choose(id);
        } catch (e) { if (mounted.current) setError((e as Error).message); }
      } while (reloadNeeded.current && mounted.current);
    })().finally(() => { loading.current = null; });
    loading.current = request; return request;
  }, [choose, forget]);
  const deleted = useCallback((id: string) => { forget(id); void load(true); }, [forget, load]);
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem('multivac:create-note');
      if (raw) { const value: unknown = JSON.parse(raw); if (Check(CreateNoteSchema, value)) { createRequest.current = value; setError('新建笔记结果待核对，请重试原请求。'); } }
    } catch { setError('新建命令的本机记录无法读取，请检查浏览器存储。'); }
    void load(); return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (active) void load(); }, [active]);
  useEffect(() => {
    function hide(id: string) {
      const next = new Map(openedRef.current); next.delete(id); openedRef.current = next; setOpened(next);
      opening.current.delete(id); securityRender(value => value + 1);
    }
    const unsubscribe = onNoteAccessChange(() => {
      for (const id of openedRef.current.keys()) if (protectedNote(id) && !unlockedNote(id)) { hide(id); setTimeout(() => { if (!hasNoteAccess(id)) clearNoteVaultMemory(id); }, 0); }
      securityRender(value => value + 1);
      const id = selectedRef.current; if (id && unlockedNote(id)) choose(id);
    });
    const changed = (event: Event) => { const id = (event as CustomEvent<string>).detail; hide(id); void load(true); };
    const frozen = (event: Event) => { const id = (event as CustomEvent<string>).detail; hide(id); };
    const storage = (event: StorageEvent) => { if (event.key?.startsWith('multivac:note-protected:')) { const id = event.key.slice('multivac:note-protected:'.length); if (event.newValue) { markProtected(id); forgetNoteAccess(id); hide(id); } void load(true); } };
    const passwordChanged = () => { for (const id of openedRef.current.keys()) if (protectedNote(id)) forgetNoteAccess(id); };
    window.addEventListener('note-protection-changed', changed); window.addEventListener('note-security-freeze', frozen); window.addEventListener('storage', storage); window.addEventListener('note-password-changed', passwordChanged);
    return () => { unsubscribe(); window.removeEventListener('note-protection-changed', changed); window.removeEventListener('note-security-freeze', frozen); window.removeEventListener('storage', storage); window.removeEventListener('note-password-changed', passwordChanged); };
  }, [load, choose]);
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
  const saved = useCallback((note: Note) => {
    remember(note);
    setNotes(previous => previous ? reuseNoteSummaries(previous, previous.map(item => item.id === note.id && note.revision >= item.revision ? protectedNote(note.id) ? { id: note.id, title: '加密笔记', revision: 1, createdAt: '', updatedAt: note.updatedAt, protection: 'encrypted' as const } : (({ body: _body, ...summary }) => summary)(note) : item)) : previous);
  }, [remember]);
  return <div className="notes-app" onPointerDown={() => { if (selected) noteUserActivity(selected); }} onKeyDown={() => { if (selected) noteUserActivity(selected); }} onWheel={() => { if (selected) noteUserActivity(selected); }} onPointerMove={() => { if (selected) noteUserActivity(selected); }}><div className="notes-layout">
    <aside className="notes-library" aria-label="笔记库">
      <header>
        <div className="notes-library-heading"><strong>全部笔记</strong>{notes && <small>{search.trim() ? `${matching?.length} / ${notes.length}` : notes.length}</small>}</div>
        <button type="button" aria-label="新建笔记" title="新建笔记" disabled={creating} onClick={() => void create()}><Plus size={17} /></button>
      </header>
      <div className="notes-library-search"><Search size={14} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="搜索笔记标题" placeholder="搜索笔记标题" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); setSearch(''); } }} />{search && <button type="button" aria-label="清除笔记搜索" onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={13} /></button>}</div>
      <div className="notes-library-list">
        {notes === null ? <p>正在读取笔记库…</p> : notes.length === 0 ? <p>还没有笔记，点击右上角开始记录。</p> : matching?.length === 0 ? <p>没有匹配的笔记</p> : matching && <NotesList notes={matching} selected={selected} onChoose={choose} onDeleteRoot={setDeleteRoot} />}
      </div>
    </aside>
    <div className="notes-main">
      {error && <div className="notes-error" role="alert">{error}<button type="button" onClick={() => void (createRequest.current ? create() : load())}>重试</button></div>}
      {selected && protectedNote(selected) && !unlockedNote(selected) ? <LockedNote key={selected} id={selected} state={notes?.find(note => note.id === selected)?.protection ?? "encrypted"} onUnlocked={() => choose(selected)} /> : selected && !opened.has(selected) && <p className="notes-hint">正在读取笔记…</p>}
      {!selected && notes !== null && <div className="notes-empty"><span className="notes-empty-icon"><NotebookPen size={30} aria-hidden="true" /></span><h2>开始记录你的想法</h2><p>写下笔记，与梳理助手一起整理。</p><button type="button" onClick={() => void create()} disabled={creating}><Plus size={15} />创建第一篇笔记</button></div>}
      {[...opened].map(([id, note]) => <OpenNote key={id} note={note} latestRevision={revisions.get(id) ?? note.revision} active={active && selected === id} selected={selected === id} onSaved={saved} deleteRoot={selected === id ? deleteRoot : null} onDeleted={deleted} />)}
    </div>
  </div></div>;
}
