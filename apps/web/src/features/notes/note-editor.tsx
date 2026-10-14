import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Save, LoaderCircle, PencilLine } from 'lucide-react';
import { NOTE_BODY_LIMIT, type Note, type NoteSelection, validNoteSelection } from '@multivac/contracts';
import { getNote, updateNote, NotesApiError } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { initialNoteDraft, noteDirty, noteSaved, noteRefreshed, NoteDraftStorage, type NoteDraft } from './note-draft.js';

export interface NoteEditorBridge {
  note: Note; dirty: boolean; busy: boolean; selection: NoteSelection | null;
  selectionToolbarRoot: HTMLDivElement | null;
  companionToggleRoot: HTMLSpanElement | null;
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
  const [selectionToolbarRoot, setSelectionToolbarRoot] = useState<HTMLDivElement | null>(null);
  const [companionToggleRoot, setCompanionToggleRoot] = useState<HTMLSpanElement | null>(null);
  const confirm = useConfirm();
  const dirty = noteDirty(draft);
  const titleHelpId = useId();
  const titleStart = useRef({ title: draft.title, revision: draft.base.revision });
  const bodyEditor = useRef<HTMLTextAreaElement>(null);

  function put(next: NoteDraft) {
    current.current = next;
    if (mounted.current) setDraft(next);
    try { storage.save(next); if (mounted.current) setStorageError(''); }
    catch (e) { if (mounted.current) setStorageError(`本机草稿未能保存：${(e as Error).message}。请保持页面打开并保存到服务端。`); }
  }
  useEffect(() => {
    mounted.current = true;
    try {
      const restored = storage.load(initial);
      put(restored);
      // 连接事件可能先于编辑器挂载；恢复旧草稿时仍须对照本次读到的服务端版本。
      if (initial.revision > restored.base.revision && (noteDirty(restored) || restored.pending)) setRemote(initial);
    }
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
    <section className="note-document" aria-label="笔记编辑器" onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); void save();
      }
    }}>
      <header className="note-document-header">
        <label className="note-title-row">
          <span className="note-title-field">
            <span className="note-title-measure" aria-hidden="true">{draft.title || '未命名笔记'}{'\u00a0'}</span>
            <textarea className="note-title" aria-label="笔记标题" aria-describedby={titleHelpId} placeholder="未命名笔记" rows={1} maxLength={200} value={draft.title} onFocus={() => { titleStart.current = { title: current.current.title, revision: current.current.base.revision }; }} onBlur={event => { event.currentTarget.scrollTop = 0; }} onChange={event => {
              put({ ...current.current, title: event.target.value.replace(/[\r\n]+/g, ' '), edit: current.current.edit + 1 }); setSelection(null);
            }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              // Esc 只还原本次标题输入，正文、原保存命令和新的服务端基线都保留。
              if (event.key === 'Escape' && current.current.base.revision === titleStart.current.revision && current.current.title !== titleStart.current.title) {
                put({ ...current.current, title: titleStart.current.title, edit: current.current.edit + 1 }); setSelection(null);
              }
              bodyEditor.current?.focus({ preventScroll: true });
            }} />
          </span>
          <PencilLine className="note-title-affordance" size={15} aria-hidden="true" />
        </label>
        <div className="note-document-toolbar">
          <div className="note-document-meta"><time dateTime={draft.base.updatedAt} title={new Date(draft.base.updatedAt).toLocaleString()}>{new Date(draft.base.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 更新</time><span id={titleHelpId} className="note-title-hint">Enter 转到正文 · Esc 撤销标题</span></div>
          <div className="note-document-actions"><span ref={setCompanionToggleRoot} /><button type="button" className={`note-save ${dirty || draft.pending ? 'pending' : 'saved'}`} disabled={busy || !!remote || !dirty && !draft.pending} onClick={() => void save()}>{busy ? <LoaderCircle size={14} aria-hidden="true" /> : dirty || draft.pending ? <Save size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{busy ? '保存中…' : draft.pending ? '核对并重试保存' : dirty ? '保存笔记' : '已保存'}</button></div>
        </div>
      </header>
      {(storageError || error) && <div className="notes-error" role="alert">{storageError || error}<button type="button" disabled={busy} onClick={() => void save()}>重试保存</button></div>}
      {remote && <div className="note-conflict" role="alert"><strong>服务端已有 v{remote.revision}，本机草稿已保留</strong><details><summary>对照服务端最新内容</summary><h3>{remote.title}</h3><pre>{remote.body}</pre></details><button type="button" disabled={busy} onClick={() => void rebase()}>核对后继续编辑本机草稿</button></div>}
      {draft.pending && <p className="notes-hint">原保存命令仍待核对；重试使用原内容。新输入继续保留。</p>}
      <div className="note-selection-slot" ref={setSelectionToolbarRoot} />
      <textarea ref={bodyEditor} className="note-markdown-editor" aria-label="Markdown 正文" placeholder="从这里开始记录，支持 Markdown…" spellCheck={false} maxLength={NOTE_BODY_LIMIT} value={draft.body} onChange={e => { put({ ...current.current, body: e.target.value, edit: current.current.edit + 1 }); setSelection(null); }} onSelect={e => {
        const editor = e.currentTarget;
        const picked = { start: editor.selectionStart, end: editor.selectionEnd, text: editor.value.slice(editor.selectionStart, editor.selectionEnd) };
        setSelection(picked.text.length <= 16000 && validNoteSelection(editor.value, picked) ? picked : null);
      }} />
      <footer className="note-editor-footer"><span>Markdown<span className="note-editing-indicator"> · 正在编辑</span></span><span>{draft.body.length.toLocaleString()} 字符{dirty ? ' · 未保存' : ''}</span></footer>
    </section>
    {companion?.({ note: draft.base, dirty: dirty || !!draft.pending || !!remote, busy, selection, selectionToolbarRoot, companionToggleRoot, clearSelection: () => setSelection(null), save, refresh })}
  </div>;
}
