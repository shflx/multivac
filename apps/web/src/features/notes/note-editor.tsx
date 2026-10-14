import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Save, LoaderCircle, PencilLine, BookOpen, Maximize2, Minimize2 } from 'lucide-react';
import { NOTE_BODY_LIMIT, type Note, type NoteSelection, validNoteSelection } from '@multivac/contracts';
import { getNote, updateNote, NotesApiError } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { useNoteSelectionToolbar } from './note-selection-toolbar.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { initialNoteDraft, noteDirty, noteSaved, noteRefreshed, NoteDraftStorage, type NoteDraft } from './note-draft.js';

export interface NoteEditorBridge {
  note: Note; busy: boolean; selection: NoteSelection | null;
  selectionToolbarRoot: HTMLDivElement | null;
  selectionToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  companionToggleRoot: HTMLSpanElement | null;
  clearSelection(): void; revealCompanion(): void; save(): Promise<Note | null>;
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
  const saveLabel = busy ? '保存中…' : draft.pending ? '核对并重试保存' : dirty ? '保存笔记' : '已保存';
  const titleHelpId = useId();
  const titleStart = useRef({ title: draft.title, revision: draft.base.revision });
  const bodyEditor = useRef<HTMLTextAreaElement>(null);
  const bodyMeasure = useRef<HTMLDivElement>(null);
  const selectedText = useRef(selection); selectedText.current = selection;
  const dismissedSelection = useRef<NoteSelection | null>(null);
  const clearSelection = useCallback(() => { dismissedSelection.current = selectedText.current; setSelection(null); }, []);
  const selectionToolbar = useNoteSelectionToolbar({ editor: bodyEditor, mirror: bodyMeasure, toolbar: selectionToolbarRoot, selection, onDismiss: clearSelection });
  const [view, setView] = useState<'edit' | 'read'>(() => {
    try { return sessionStorage.getItem(`multivac:note-view:${initial.id}`) === 'read' ? 'read' : 'edit'; } catch { return 'edit'; }
  });
  const [focused, setFocused] = useState(false);
  const paperScroll = useRef<HTMLDivElement>(null);
  const viewScroll = useRef({ edit: 0, read: 0 });
  const focusBodyAfterView = useRef(false);

  function scrollContainer() {
    const paper = paperScroll.current;
    // 助手上下排列时由整篇笔记滚动，宽屏时由文档自身滚动。
    return paper && getComputedStyle(paper).overflowY === 'visible' ? paper.closest<HTMLDivElement>('.notes-detail') : paper;
  }
  function changeView(next: 'edit' | 'read') {
    if (next === view) return;
    viewScroll.current[view] = scrollContainer()?.scrollTop ?? 0;
    setSelection(null); setView(next);
    try { sessionStorage.setItem(`multivac:note-view:${initial.id}`, next); } catch {}
  }
  function focusBody() {
    if (view === 'edit') bodyEditor.current?.focus({ preventScroll: true });
    else { focusBodyAfterView.current = true; changeView('edit'); }
  }
  useLayoutEffect(() => {
    const container = scrollContainer();
    if (container) container.scrollTop = viewScroll.current[view];
    if (focusBodyAfterView.current) { focusBodyAfterView.current = false; bodyEditor.current?.focus({ preventScroll: true }); }
  }, [view]);

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
    <section className="note-document" data-focused={focused} aria-label="笔记编辑器" onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopPropagation(); void save();
      }
    }}>
      <div className="note-editor-toolbar">
        <div className="note-view-switch" role="group" aria-label="笔记显示模式"><button type="button" aria-pressed={view === 'edit'} onClick={() => changeView('edit')}><PencilLine size={14} aria-hidden="true" />编辑</button><button type="button" aria-pressed={view === 'read'} onClick={() => changeView('read')}><BookOpen size={14} aria-hidden="true" />阅读</button></div>
        <div className="note-document-actions"><span ref={setCompanionToggleRoot} /><button type="button" className={`note-save ${dirty || draft.pending ? 'pending' : 'saved'}`} aria-label={saveLabel} title={dirty && !draft.pending && !busy ? '保存笔记（Ctrl/⌘+S）' : saveLabel} aria-keyshortcuts="Control+s Meta+s" disabled={busy || !!remote || !dirty && !draft.pending} onClick={() => void save()}>{busy ? <LoaderCircle size={16} aria-hidden="true" /> : dirty || draft.pending ? <Save size={16} aria-hidden="true" /> : <><Check size={13} aria-hidden="true" /><span>已保存</span></>}</button><button type="button" className="note-focus-toggle" aria-pressed={focused} aria-label={focused ? '退出专注写作' : '专注写作'} title={focused ? '退出专注写作' : '专注写作'} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
      </div>
      {(storageError || error) && <div className="notes-error" role="alert">{storageError || error}<button type="button" disabled={busy} onClick={() => void save()}>重试保存</button></div>}
      {remote && <div className="note-conflict" role="alert"><strong>服务端已有 v{remote.revision}，本机草稿已保留</strong><details><summary>对照服务端最新内容</summary><h3>{remote.title}</h3><pre>{remote.body}</pre></details><button type="button" disabled={busy} onClick={() => void rebase()}>核对后继续编辑本机草稿</button></div>}
      {draft.pending && <p className="notes-hint">原保存命令仍待核对；重试使用原内容。新输入继续保留。</p>}
      <div className="note-document-scroll" ref={paperScroll}><div className="note-paper">
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
                focusBody();
              }} />
            </span>
            <PencilLine className="note-title-affordance" size={15} aria-hidden="true" />
          </label>
          <div className="note-document-meta"><span id={titleHelpId} className="note-title-hint">Enter 转到正文 · Esc 撤销标题</span></div>
        </header>
        <div className="note-writing-surface" hidden={view !== 'edit'}>
          <div ref={bodyMeasure} className="note-body-measure" aria-hidden="true">{draft.body}{'\n\u00a0'}</div>
          <textarea ref={bodyEditor} rows={1} className="note-markdown-editor" aria-label="Markdown 正文" placeholder="从这里开始记录，支持 Markdown…" spellCheck={false} maxLength={NOTE_BODY_LIMIT} value={draft.body} onPointerDown={selectionToolbar.onPointerDown} onKeyDown={selectionToolbar.onEditorKeyDown} onChange={e => { dismissedSelection.current = null; put({ ...current.current, body: e.target.value, edit: current.current.edit + 1 }); setSelection(null); }} onSelect={e => {
          const editor = e.currentTarget;
          const picked = { start: editor.selectionStart, end: editor.selectionEnd, text: editor.value.slice(editor.selectionStart, editor.selectionEnd) };
          const dismissed = dismissedSelection.current;
          if (dismissed && dismissed.start === picked.start && dismissed.end === picked.end && dismissed.text === picked.text) return;
          dismissedSelection.current = null;
          setSelection(picked.text.length <= 16000 && validNoteSelection(editor.value, picked) ? picked : null);
        }} />
          <div className="note-selection-slot" ref={setSelectionToolbarRoot} />
        </div>
        <article className="note-reading-surface" aria-label="笔记阅读内容" hidden={view !== 'read'}>{view === 'read' && (draft.body ? <MarkdownBody identity={`note-${initial.id}`} text={draft.body} /> : <p className="note-reading-empty">还没有正文，切换到编辑开始记录。</p>)}</article>
      </div></div>
      <footer className="note-editor-footer"><span>{view === 'read' ? '阅读' : 'Markdown'}<span className="note-editing-indicator"> · 正在编辑</span><time dateTime={draft.base.updatedAt} title={new Date(draft.base.updatedAt).toLocaleString()}>{new Date(draft.base.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></span><span>{draft.body.length.toLocaleString()} 字符{dirty ? ' · 未保存' : ''}</span></footer>
    </section>
    {companion?.({ note: draft.base, busy, selection, selectionToolbarRoot, selectionToolbarKeyDown: selectionToolbar.onToolbarKeyDown, companionToggleRoot, clearSelection, revealCompanion: () => setFocused(false), save })}
  </div>;
}
