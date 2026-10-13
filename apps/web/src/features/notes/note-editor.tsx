import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NOTE_BODY_LIMIT, type Note, type NoteSelection, validNoteSelection } from '@multivac/contracts';
import { getNote, updateNote, NotesApiError } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { initialNoteDraft, noteDirty, noteSaved, noteRefreshed, NoteDraftStorage, type NoteDraft } from './note-draft.js';

export interface NoteEditorBridge {
  note: Note; dirty: boolean; busy: boolean; selection: NoteSelection | null;
  clearSelection(): void; save(): Promise<Note | null>; refresh(): Promise<void>;
}
export function NoteEditor({ initial, onSaved, companion }: { initial: Note; onSaved(note: Note): void; companion?: (bridge: NoteEditorBridge) => ReactNode }) {
  const [storage] = useState(() => new NoteDraftStorage(initial.id));
  const [draft, setDraft] = useState<NoteDraft>(() => {
    try { return storage.load(initial); } catch { return initialNoteDraft(initial); }
  });
  const current = useRef(draft); current.current = draft;
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef<Promise<Note | null> | null>(null);
  const [remote, setRemote] = useState<Note | null>(null);
  const [selection, setSelection] = useState<NoteSelection | null>(null);
  const confirm = useConfirm();
  const dirty = noteDirty(draft);

  function put(next: NoteDraft) {
    current.current = next;
    if (mounted.current) setDraft(next);
    try { storage.save(next); if (mounted.current) setStorageError(''); }
    catch (e) { if (mounted.current) setStorageError(`本机草稿未能保存：${(e as Error).message}。请保持页面打开并保存到服务端。`); }
  }
  useEffect(() => {
    mounted.current = true;
    try { const restored = storage.load(initial); put(restored); }
    catch (e) { setStorageError((e as Error).message); }
    return () => { mounted.current = false; };
  }, [storage]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (storageError && (noteDirty(current.current) || current.current.pending)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [storageError]);

  async function refresh() {
    const note = await getNote(initial.id);
    if (!mounted.current) return;
    const local = current.current;
    if (note.revision < local.base.revision) return;
    if (note.revision > local.base.revision && (noteDirty(local) || local.pending)) setRemote(note);
    else { put(noteRefreshed(local, note)); onSaved(note); }
  }
  useWorkbenchEvents(event => {
    if (event.type === 'workbench.connected' || event.type === 'notes.changed' && event.noteId === initial.id) void refresh().catch(e => { if (mounted.current) setError((e as Error).message); });
  });
  useEffect(() => {
    const focus = () => { void refresh().catch(e => { if (mounted.current) setError((e as Error).message); }); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [initial.id]);

  function save(): Promise<Note | null> {
    if (saving.current) return saving.current;
    if (remote) { setError('请先核对版本冲突。'); return Promise.resolve(null); }
    const local = current.current;
    if (!noteDirty(local) && !local.pending) return Promise.resolve(local.base);
    const request = local.pending ?? { commandId: newCommandId(), expectedRevision: local.base.revision, title: local.title, body: local.body };
    put({ ...local, pending: request }); setBusy(true); setError('');
    const operation = (async () => {
      try {
        const saved = await updateNote(initial.id, request);
        put(noteSaved(current.current, saved, request));
        if (mounted.current) { setRemote(null); onSaved(saved); }
        // 发送期间继续编辑的内容仍是未保存草稿，助手不得使用旧正文冒充当前输入。
        return noteDirty(current.current) ? null : saved;
      } catch (e) {
        if (mounted.current) {
          setError((e as Error).message);
          if (e instanceof NotesApiError && e.status === 409) { try { await refresh(); } catch {} }
        }
        return null;
      } finally { saving.current = null; if (mounted.current) setBusy(false); }
    })();
    saving.current = operation; return operation;
  }
  async function rebase() {
    if (!remote || busy) return;
    const latest = remote;
    const accepted = await confirm({ title: '以服务端最新版本继续编辑？', description: '保留当前本机标题与正文，下一次保存将以你已核对的服务端版本为基线。请先对照内容并合并需要保留的修改。', confirmLabel: '保留本机内容并继续' });
    if (!accepted) return;
    put({ ...current.current, base: latest, pending: null }); setRemote(null); setError(''); setSelection(null);
  }
  return <div className={`notes-detail ${companion ? 'with-companion' : ''}`}>
    <section className="note-document" aria-label="笔记编辑器">
      <header className="note-document-header">
        <div><input aria-label="笔记标题" maxLength={200} value={draft.title} onChange={e => { put({ ...current.current, title: e.target.value, edit: current.current.edit + 1 }); setSelection(null); }} /><small>Markdown · 更新于 {new Date(draft.base.updatedAt).toLocaleString()} · v{draft.base.revision}</small></div>
        <button type="button" disabled={busy || !!remote || !dirty && !draft.pending} onClick={() => void save()}>{busy ? '保存中…' : draft.pending ? '核对并重试保存' : dirty ? '保存笔记' : '已保存'}</button>
      </header>
      {(storageError || error) && <div className="notes-error" role="alert">{storageError || error}<button type="button" disabled={busy} onClick={() => void save()}>重试保存</button></div>}
      {remote && <div className="note-conflict" role="alert"><strong>服务端已有 v{remote.revision}，本机草稿已保留</strong><details><summary>对照服务端最新内容</summary><h3>{remote.title}</h3><pre>{remote.body}</pre></details><button type="button" disabled={busy} onClick={() => void rebase()}>核对后继续编辑本机草稿</button></div>}
      {draft.pending && <p className="notes-hint">原保存命令仍待核对；重试使用原内容。新输入继续保留。</p>}
      {dirty && !draft.pending && <p className="notes-hint">有未保存修改，切换与刷新保留本机草稿。</p>}
      <textarea className="note-markdown-editor" aria-label="Markdown 正文" spellCheck={false} maxLength={NOTE_BODY_LIMIT} value={draft.body} onChange={e => { put({ ...current.current, body: e.target.value, edit: current.current.edit + 1 }); setSelection(null); }} onSelect={e => {
        const editor = e.currentTarget;
        const picked = { start: editor.selectionStart, end: editor.selectionEnd, text: editor.value.slice(editor.selectionStart, editor.selectionEnd) };
        setSelection(picked.text.length <= 16000 && validNoteSelection(editor.value, picked) ? picked : null);
      }} />
    </section>
    {companion?.({ note: draft.base, dirty: dirty || !!draft.pending || !!remote, busy, selection, clearSelection: () => setSelection(null), save, refresh })}
  </div>;
}
