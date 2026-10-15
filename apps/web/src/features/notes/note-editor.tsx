import { createPortal } from 'react-dom';
import { Check as checkSchema } from 'typebox/value';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Save, LoaderCircle, PencilLine, BookOpen, Maximize2, Minimize2, History, Trash2 } from 'lucide-react';
import { NOTE_BODY_LIMIT, DeleteNoteSchema, type DeleteNote, type Note, type NoteSelection, validNoteSelection } from '@multivac/contracts';
import { getNote, updateNote, deleteNote, NotesApiError } from '../../data/notes-api.js';
import { newCommandId } from '../../data/command-id.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { useNoteSelectionToolbar } from './note-selection-toolbar.js';
import { NoteVersions } from './note-versions.js';
import { useConfirm } from '../../components/confirm-card.js';
import { initialNoteDraft, noteDirty, noteSaved, noteRefreshed, NoteDraftStorage, type NoteDraft } from './note-draft.js';

export interface NoteEditorBridge {
  note: Note; active: boolean; busy: boolean; selection: NoteSelection | null;
  selectionToolbarRoot: HTMLDivElement | null;
  selectionToolbarKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  companionToggleRoot: HTMLSpanElement | null;
  clearSelection(): void; revealCompanion(): void; save(): Promise<Note | null>;
}
export function NoteEditor({ initial, latestRevision = initial.revision, active = true, onSaved, onDeleted, deleteRoot, companion }: { initial: Note; latestRevision?: number; active?: boolean; onSaved(note: Note): void; onDeleted(): void; deleteRoot?: HTMLElement | null; companion?: (bridge: NoteEditorBridge) => ReactNode }) {
  const [storage] = useState(() => new NoteDraftStorage(initial.id));
  const [draft, setDraft] = useState<NoteDraft>(() => {
    try { return storage.load(initial); } catch { return initialNoteDraft(initial); }
  });
  const current = useRef(draft); current.current = draft;
  const mounted = useRef(true);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(false);
  const deletionKey = `multivac:note-delete:${initial.id}`;
  const [pendingDeletion, setPendingDeletion] = useState<DeleteNote | null>(() => {
    try { const value: unknown = JSON.parse(sessionStorage.getItem(deletionKey) ?? 'null'); return checkSchema(DeleteNoteSchema, value) ? value : null; } catch { return null; }
  });
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteLabel = pendingDeletion ? '核对并重试删除' : '删除笔记';
  const saving = useRef<Promise<Note | null> | null>(null);
  const refreshing = useRef<Promise<void> | null>(null);
  const [remote, setRemote] = useState<Note | null>(null);
  const remoteRef = useRef(remote); remoteRef.current = remote;
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
  const [historyOpen, setHistoryOpen] = useState(false);
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

  function refresh(): Promise<void> {
    if (refreshing.current) return refreshing.current;
    const request = getNote(initial.id).then(note => {
      if (!mounted.current) return;
      const local = current.current;
      if (note.revision <= local.base.revision || note.revision <= (remoteRef.current?.revision ?? 0)) return;
      if (noteDirty(local) || local.pending) { remoteRef.current = note; setRemote(note); }
      else { put(noteRefreshed(local, note)); onSaved(note); }
    }).finally(() => { refreshing.current = null; });
    refreshing.current = request; return request;
  }
  useEffect(() => {
    // 摘要已确认有新版本时才取正文；读取中发生的更新会在结束后按最新已知版本继续核对。
    if (latestRevision <= Math.max(current.current.base.revision, remoteRef.current?.revision ?? 0)) return;
    let attached = true;
    void refresh().then(() => {
      if (attached && latestRevision > Math.max(current.current.base.revision, remoteRef.current?.revision ?? 0)) return refresh();
    }).catch(e => { if (mounted.current) setError((e as Error).message); });
    return () => { attached = false; };
  }, [latestRevision]);
  useEffect(() => {
    if (!active) return;
    const focus = () => { void refresh().catch(e => { if (mounted.current) setError((e as Error).message); }); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [initial.id, active]);

  function save(): Promise<Note | null> {
    if (deleting || pendingDeletion) return Promise.resolve(null);
    if (saving.current) return saving.current;
    if (remoteRef.current && !current.current.pending) { setError('请先核对版本冲突。'); return Promise.resolve(null); }
    const local = current.current;
    if (!noteDirty(local) && !local.pending) return Promise.resolve(local.base);
    const request = local.pending ?? { commandId: newCommandId(), expectedRevision: local.base.revision, title: local.title, body: local.body };
    put({ ...local, pending: request }); setBusy(true); setError('');
    const operation = (async () => {
      try {
        const saved = await updateNote(initial.id, request);
        put(noteSaved(current.current, saved, request));
        // 原请求可能已提交并收到同步事件；回执只清除不晚于它的远端版本，不能吞掉之后的并发修改。
        const newer = remoteRef.current && remoteRef.current.revision > saved.revision ? remoteRef.current : null;
        remoteRef.current = newer;
        if (mounted.current) { setRemote(newer); onSaved(saved); }
        // 发送期间继续编辑或服务端已有更新时，助手不得使用旧正文冒充当前输入。
        return noteDirty(current.current) || newer ? null : saved;
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
  async function restoreVersion(version: Note): Promise<boolean> {
    const local = current.current;
    if (deleting || pendingDeletion || version.id !== initial.id || saving.current || remote || noteDirty(local) || local.pending || version.title === local.title && version.body === local.body) return false;
    // 恢复复用普通保存的命令与草稿保护，未知结果也能按原请求重试；不改写旧快照。
    put({ ...local, title: version.title, body: version.body, edit: local.edit + 1 });
    setSelection(null);
    const saved = await save();
    if (saved) scrollContainer()?.scrollTo({ top: 0 });
    return saved !== null;
  }
  async function remove() {
    if (deleting || saving.current || current.current.pending || remoteRef.current && !pendingDeletion) return;
    const request = pendingDeletion ?? { commandId: newCommandId(), expectedRevision: current.current.base.revision };
    if (!pendingDeletion && !await confirm({ title: '删除这篇笔记？', description: `「${current.current.title || '未命名笔记'}」的正文、全部历史版本和本机未保存修改将一并清理，无法恢复。`, confirmLabel: '删除笔记', tone: 'danger' })) return;
    if (saving.current || current.current.pending) return;
    setDeleting(true); setDeleteError(''); clearSelection();
    try {
      sessionStorage.setItem(deletionKey, JSON.stringify(request)); setPendingDeletion(request);
      await deleteNote(initial.id, request);
      onDeleted();
    } catch (e) {
      if (e instanceof NotesApiError && e.status === 404) { onDeleted(); return; }
      if (e instanceof NotesApiError && e.status >= 400 && e.status < 500) {
        sessionStorage.removeItem(deletionKey); setPendingDeletion(null);
        void refresh().catch(() => {});
      }
      if (mounted.current) setDeleteError((e as Error).message);
    } finally { if (mounted.current) setDeleting(false); }
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
        <div className="note-document-actions"><span ref={setCompanionToggleRoot} /><button type="button" className="note-history-toggle" disabled={deleting || !!pendingDeletion} aria-label="版本历史" title="版本历史" onClick={() => { clearSelection(); setHistoryOpen(true); }}><History size={16} aria-hidden="true" /></button><button type="button" className={`note-save ${dirty || draft.pending ? 'pending' : 'saved'}`} aria-label={saveLabel} title={dirty && !draft.pending && !busy ? '保存笔记（Ctrl/⌘+S）' : saveLabel} aria-keyshortcuts="Control+s Meta+s" disabled={deleting || !!pendingDeletion || busy || !!remote && !draft.pending || !dirty && !draft.pending} onClick={() => void save()}>{busy ? <LoaderCircle size={16} aria-hidden="true" /> : dirty || draft.pending ? <Save size={16} aria-hidden="true" /> : <><Check size={13} aria-hidden="true" /><span>已保存</span></>}</button><button type="button" className="note-focus-toggle" aria-pressed={focused} aria-label={focused ? '退出专注写作' : '专注写作'} title={focused ? '退出专注写作' : '专注写作'} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
      </div>
      {deleteError && <div className="notes-error" role="alert">{deleteError}</div>}
      {pendingDeletion && <p className="notes-hint">删除结果待核对，请重试原删除请求；核对期间暂停编辑与保存。</p>}
      {(storageError || error) && <div className="notes-error" role="alert">{storageError || error}<button type="button" disabled={busy} onClick={() => void save()}>重试保存</button></div>}
      {remote && <div className="note-conflict" role="alert"><strong>服务端已有 v{remote.revision}，本机草稿已保留</strong><details><summary>对照服务端最新内容</summary><h3>{remote.title}</h3><pre>{remote.body}</pre></details><button type="button" disabled={busy} onClick={() => void rebase()}>核对后继续编辑本机草稿</button></div>}
      {draft.pending && <p className="notes-hint">原保存命令仍待核对；重试使用原内容。新输入继续保留。</p>}
      <div className="note-document-scroll" ref={paperScroll}><div className="note-paper">
        <header className="note-document-header">
          <label className="note-title-row">
            <span className="note-title-field">
              <span className="note-title-measure" aria-hidden="true">{draft.title || '未命名笔记'}{'\u00a0'}</span>
              <textarea className="note-title" disabled={deleting || !!pendingDeletion} aria-label="笔记标题" aria-describedby={titleHelpId} placeholder="未命名笔记" rows={1} maxLength={200} value={draft.title} onFocus={() => { titleStart.current = { title: current.current.title, revision: current.current.base.revision }; }} onBlur={event => { event.currentTarget.scrollTop = 0; }} onChange={event => {
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
          <textarea ref={bodyEditor} rows={1} className="note-markdown-editor" disabled={deleting || !!pendingDeletion} aria-label="Markdown 正文" placeholder="从这里开始记录，支持 Markdown…" spellCheck={false} maxLength={NOTE_BODY_LIMIT} value={draft.body} onPointerDown={selectionToolbar.onPointerDown} onKeyDown={selectionToolbar.onEditorKeyDown} onChange={e => { dismissedSelection.current = null; put({ ...current.current, body: e.target.value, edit: current.current.edit + 1 }); setSelection(null); }} onSelect={e => {
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
    {historyOpen && <NoteVersions current={draft.base} knownRevision={Math.max(draft.base.revision, remote?.revision ?? 0)} blocked={busy ? '请等待当前保存完成。' : remote ? '请先核对笔记的版本冲突。' : draft.pending ? '请先核对原保存结果。' : dirty ? '请先保存当前草稿，再恢复历史版本。' : ''} onRestore={restoreVersion} onClose={() => setHistoryOpen(false)} />}
    {deleteRoot && createPortal(<button type="button" className="note-delete" aria-label={deleteLabel} title={draft.pending ? '请先核对原保存结果' : remote ? '请先核对版本冲突' : deleteLabel} disabled={busy || deleting || !!draft.pending || !!remote && !pendingDeletion} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" /></button>, deleteRoot)}
    {companion?.({ note: draft.base, active: active && !focused, busy: busy || deleting || !!pendingDeletion, selection, selectionToolbarRoot, selectionToolbarKeyDown: selectionToolbar.onToolbarKeyDown, companionToggleRoot, clearSelection, revealCompanion: () => setFocused(false), save })}
  </div>;
}
