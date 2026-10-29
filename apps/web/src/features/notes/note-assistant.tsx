import { protectedNote } from '../../data/note-access.js';
import { noteVaultStorage } from './note-vault.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Quote, X, Send, Square, Sparkles } from 'lucide-react';
import { Check } from 'typebox/value';
import { NoteSelectionSchema, type NoteDiscussion, type NoteSelection, type NoteSnapshot, validNoteSelection } from '@multivac/contracts';
import { ensureNoteCompanion, prepareNoteContext } from '../../data/note-assistant-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { ModelSelector } from '../assistant/model-selector.js';
import { SessionModelContext } from '../assistant/session-model.js';
import type { NoteEditorBridge } from './note-editor.js';

type DraftQuote = { revision: number; selection: NoteSelection };
export function NoteAssistant({ bridge }: { bridge: NoteEditorBridge }) {
  const noteId = bridge.note.id;
  const quoteStorage = () => protectedNote(noteId) ? noteVaultStorage(noteId, 'session') : sessionStorage;
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem(`multivac:note-assistant:${noteId}`) === 'open'; } catch { return false; } });
  const [started, setStarted] = useState(open);
  const [discussion, setDiscussion] = useState<NoteDiscussion | null>(null);
  const [quote, setQuote] = useState<DraftQuote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const discussionRef = useRef(discussion);
  const loading = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  function load(): Promise<void> {
    if (loading.current) return loading.current;
    const request = (async () => {
      const root = await ensureNoteCompanion(noteId);
      if (!mounted.current) return;
      let restoreError = '';
      if (!discussionRef.current) {
        try {
          const raw = quoteStorage().getItem(`multivac:note-quote:${root.sessionId}`);
          if (raw) {
            const restored = JSON.parse(raw) as DraftQuote;
            if (!Number.isSafeInteger(restored.revision) || restored.revision < 1 || !Check(NoteSelectionSchema, restored.selection)) throw new Error('引用草稿格式无效');
            setQuote(restored);
          }
        } catch { restoreError = '引用草稿未能恢复，请重新选择引用片段。'; }
      }
      discussionRef.current = root; setDiscussion(root); setError(restoreError);
    })().finally(() => { loading.current = null; });
    loading.current = request; return request;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, [noteId]);
  const selected = Boolean(bridge.selection);
  useEffect(() => {
    if (open) setStarted(true);
    if ((selected || open && bridge.active) && !discussionRef.current) void load().catch(e => { if (mounted.current) setError((e as Error).message); });
  }, [noteId, bridge.active, open, selected]);
  useWorkbenchEvents(event => {
    if (event.type === 'workbench.connected' && (selected || open && bridge.active) && !discussionRef.current) void load().catch(e => { if (mounted.current) setError((e as Error).message); });
  });

  function changeQuote(value: DraftQuote | null) {
    setQuote(value);
    const id = discussionRef.current?.sessionId;
    if (!id) return;
    try { if (value) quoteStorage().setItem(`multivac:note-quote:${id}`, JSON.stringify(value)); else quoteStorage().removeItem(`multivac:note-quote:${id}`); }
    catch (e) { setError(`引用草稿未能保存：${(e as Error).message}`); }
  }
  async function snapshot(picked: NoteSelection | null, expectedRevision?: number): Promise<NoteSnapshot> {
    if (!discussion) throw new Error('请等待读取对话后再提问。');
    const saved = await bridge.save();
    if (!saved) throw new Error('请先完成笔记保存并核对最新草稿。');
    if (expectedRevision !== undefined && saved.revision !== expectedRevision) throw new Error('引用片段的正文已变化，请移除引用并重新选取。');
    if (picked && !validNoteSelection(saved.body, picked)) throw new Error('选区已随编辑变化，请重新选取。');
    return prepareNoteContext(noteId, { commandId: newCommandId(), id: newCommandId(), sessionId: discussion.sessionId, revision: saved.revision, selection: picked });
  }
  async function referenceSelection() {
    if (!discussion || !bridge.selection || busy) return;
    const picked = bridge.selection;
    setBusy(true); setError(''); bridge.revealCompanion(); setOpen(true);
    try {
      const frozen = await snapshot(picked);
      changeQuote({ revision: frozen.revision, selection: picked });
      bridge.clearSelection();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function toggle() { setOpen(value => { try { sessionStorage.setItem(`multivac:note-assistant:${noteId}`, value ? 'closed' : 'open'); } catch {} return !value; }); }
  return <div className={`note-assistant-shell ${open ? 'open' : 'closed'}`}>
    {bridge.companionToggleRoot && createPortal(<button type="button" className="note-companion-toggle" aria-label="梳理助手" title={open ? '收起梳理助手' : '展开梳理助手'} aria-pressed={open} aria-expanded={open} aria-controls={`note-companion-${noteId}`} onClick={toggle}><Sparkles size={16} aria-hidden="true" /></button>, bridge.companionToggleRoot)}
    {bridge.selection && bridge.selectionToolbarRoot && createPortal(<div className="note-selection-bar" role="toolbar" aria-label="笔记选区操作" onKeyDown={bridge.selectionToolbarKeyDown} onMouseDown={event => event.preventDefault()}><button type="button" aria-label="引用给助手" title="引用给梳理助手" disabled={busy || bridge.busy || !discussion} onClick={() => void referenceSelection()}><Quote size={13} aria-hidden="true" />引用</button></div>, bridge.selectionToolbarRoot)}
    <aside id={`note-companion-${noteId}`} className="note-companion" aria-label="梳理助手" hidden={!open}>
      <header className="note-companion-header"><strong>梳理助手</strong></header>{protectedNote(noteId) && <p className="notes-hint">发送提问会将笔记正文及引用发送给当前所选模型。</p>}
      {error && <div role="alert" className="notes-error">{error}{!discussion && <button type="button" onClick={() => void load().catch(e => setError((e as Error).message))}>重新读取</button>}</div>}
      {!discussion && !error && <p className="notes-hint">正在读取对话…</p>}
      {discussion && started && <NoteThread discussion={discussion} visible={open && bridge.active} quote={quote} clearQuote={() => changeQuote(null)} snapshot={snapshot} />}
    </aside>
  </div>;
}

function NoteThread({ discussion, visible, quote, clearQuote, snapshot }: { discussion: NoteDiscussion; visible: boolean; quote: DraftQuote | null; clearQuote(): void; snapshot(selection: NoteSelection | null, expectedRevision?: number): Promise<NoteSnapshot> }) {
  const entry = useAssistantSession(discussion.sessionId, visible), session = entry?.session;
  const currentQuote = useRef(quote); currentQuote.current = quote;
  const [error, setError] = useState('');
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const messages = session?.timeline.flatMap(item => item.kind === 'message' ? [item.message] : []) ?? [];
  useLayoutEffect(() => {
    if (visible && follow.current && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [visible, messages.map(m => `${m.id}:${m.text.length}`).join('|')]);
  async function send() {
    if (!session || session.runActive || session.submitting || preparingRef.current || session.pendingSubmission || quote && quote.selection.text.length > 16000) return;
    preparingRef.current = true; setPreparing(true); setError('');
    try {
      if (!session.pageState.draft.trim()) return;
      const frozen = await snapshot(quote?.selection ?? null, quote?.revision);
      follow.current = true;
      await session.submitDraft({ clearOnSubmit: true, omitQuote: true, contextRefs: [{ kind: 'note', snapshotId: frozen.id }], onStart: () => {
        if (JSON.stringify(currentQuote.current) === JSON.stringify(quote)) clearQuote();
      } });
      composer.current?.focus({ preventScroll: true });
    } catch (e) { setError((e as Error).message); }
    finally { preparingRef.current = false; setPreparing(false); }
  }
  return <div className="note-thread" hidden={!visible}>
    {session?.initialError && <div className="notes-error" role="alert">{session.initialError}<button type="button" onClick={session.reload}>重试读取讨论</button></div>}
    <div className="note-companion-thread" ref={thread} onScroll={e => { const element = e.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
      {session?.hasMore && <button type="button" disabled={session.loadingEarlier} onClick={() => { follow.current = false; session.loadEarlier(); }}>更早的消息</button>}
      {session?.historyError && <p role="alert">{session.historyError}</p>}
      {!messages.length && <div className="note-companion-welcome"><strong>聊聊这篇笔记</strong><p>直接提问，也可以选中正文引用。</p></div>}
      {messages.map(message => <article className={`note-message ${message.role}`} key={message.id}><strong>{message.role === 'user' ? '你' : '助手'}</strong><MarkdownBody identity={message.id} text={message.text} imageSessionId={discussion.sessionId} {...(message.imageReferences ? { imageReferences: message.imageReferences } : {})} {...(message.fileReferences ? { fileReferences: message.fileReferences } : {})} /></article>)}
    </div>
    {(error || session?.sendError || session && ['failed', 'unknown'].includes(session.runFeedback.phase)) && <div className="notes-error" role="alert">{error || session?.sendError || session?.runFeedback.message}</div>}
    {session?.pendingSubmission?.unknown && <div className="notes-error"><span>发送结果未知，保留原命令和正文快照。</span><button type="button" onClick={() => void session.checkPendingSubmission()}>核对结果</button><button type="button" onClick={() => void session.retryUnknownSubmission()}>按原命令重试</button></div>}
    {session?.failedSubmissions.map(failure => <div className="notes-error" role="alert" key={failure.commandId}><p>{failure.text}</p><p>{failure.error}</p><button type="button" disabled={session.runActive || !!session.pendingSubmission} onClick={() => void session.retryFailedSubmission(failure.commandId)}>重试这次提问</button><button type="button" onClick={() => { if (!session.restoreFailedSubmission(failure.commandId)) setError('请先处理当前提问草稿。'); }}>恢复提问草稿</button></div>)}
    <form className="note-companion-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {quote && <div className="note-quote"><small>引用片段</small><pre>{quote.selection.text}</pre><button type="button" aria-label="移除笔记选区引用" onClick={clearQuote}><X size={13} /></button></div>}
      <textarea ref={composer} aria-label="向梳理助手提问" placeholder="聊聊这篇笔记…" maxLength={12000} value={session?.pageState.draft ?? ''} disabled={!session || session.status !== 'ready'} onChange={e => session?.updateDraft(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
      }} />
      <footer>{entry && <SessionModelContext.Provider value={entry.model}><ModelSelector active={visible} running={Boolean(session?.runActive)} compact portal menuId={`note-model-${discussion.sessionId}`} /></SessionModelContext.Provider>}{session?.runActive ? <button type="button" aria-label="停止梳理助手" disabled={session.cancelling} onClick={() => void session.cancelCurrentRun()}><Square size={16} /></button> : <button type="submit" aria-label="发送给梳理助手" disabled={!session?.canSubmit || preparing}><Send size={16} /></button>}</footer>
    </form>
    {session?.saveFeedback.phase === 'error' && <div className="notes-error" role="alert">{session.saveFeedback.message}<button type="button" onClick={session.retrySave}>重试保存讨论草稿</button></div>}
  </div>;
}
