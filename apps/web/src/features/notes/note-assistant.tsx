import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, ArrowLeft, SquareStack, Quote, X, Send, Square } from 'lucide-react';
import { type NoteDiscussion, type NoteSelection, type NoteSnapshot, type CreateNoteDiscussion, validNoteSelection } from '@multivac/contracts';
import { ensureNoteCompanion, noteDiscussions, prepareNoteContext, deepenNoteDiscussion } from '../../data/note-assistant-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { ModelSelector } from '../assistant/model-selector.js';
import { SessionModelContext } from '../assistant/session-model.js';
import type { NoteEditorBridge } from './note-editor.js';

type DraftQuote = { revision: number; selection: NoteSelection };
export interface NoteAssistantProps { bridge: NoteEditorBridge; suggestions?: (discussion: NoteDiscussion, sessionId: string) => ReactNode; messageActions?: (message: { piEntryId: string; role: 'user' | 'assistant'; text: string; noteContext?: NoteSnapshot }, sessionId: string, ready: boolean) => ReactNode }
export function NoteAssistant({ bridge, suggestions, messageActions }: NoteAssistantProps) {
  const noteId = bridge.note.id;
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem(`multivac:note-assistant:${noteId}`) !== 'closed'; } catch { return true; } });
  const [discussions, setDiscussions] = useState<NoteDiscussion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [quotes, setQuotes] = useState<Record<string, DraftQuote | null>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<CreateNoteDiscussion | null>(null);
  const initializing = useRef<Promise<void> | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const loadGeneration = useRef(0);
  const mounted = useRef(true);

  function activate(id: string) {
    setSelected(id); selectedRef.current = id;
    setVisited(previous => new Set(previous).add(id));
    try {
      sessionStorage.setItem(`multivac:note-discussion:${noteId}`, id);
      const raw = sessionStorage.getItem(`multivac:note-quote:${id}`);
      if (raw) setQuotes(previous => ({ ...previous, [id]: JSON.parse(raw) as DraftQuote }));
    } catch (e) { setError(`引用草稿恢复失败：${(e as Error).message}`); }
  }
  function quote(id: string, value: DraftQuote | null) {
    setQuotes(previous => ({ ...previous, [id]: value }));
    try { if (value) sessionStorage.setItem(`multivac:note-quote:${id}`, JSON.stringify(value)); else sessionStorage.removeItem(`multivac:note-quote:${id}`); }
    catch (e) { setError(`引用草稿未能保存：${(e as Error).message}`); }
  }
  async function load() {
    const ticket = ++loadGeneration.current;
    const root = await ensureNoteCompanion(noteId);
    const result = await noteDiscussions(noteId);
    if (!mounted.current || ticket !== loadGeneration.current) return;
    setDiscussions(result.discussions);
    if (!selectedRef.current) {
      let restored: string | null = null;
      try { restored = sessionStorage.getItem(`multivac:note-discussion:${noteId}`); } catch {}
      activate(result.discussions.some(d => d.sessionId === restored) ? restored! : root.sessionId);
    }
  }
  useEffect(() => {
    mounted.current = true;
    try { const raw = sessionStorage.getItem(`multivac:note-deepen:${noteId}`); if (raw) request.current = JSON.parse(raw) as CreateNoteDiscussion; } catch { setError('深入命令无法恢复，请核对本机存储。'); }
    initializing.current = load().catch(e => { if (mounted.current) setError((e as Error).message); }).finally(() => { initializing.current = null; });
    return () => { mounted.current = false; ++loadGeneration.current; };
  }, [noteId]);
  useWorkbenchEvents(event => { if ((event.type === 'notes.changed' && event.noteId === noteId || event.type === 'workbench.connected') && !initializing.current) void load().catch(e => { if (mounted.current) setError((e as Error).message); }); });

  async function snapshot(id: string, picked: NoteSelection | null, expectedRevision?: number): Promise<NoteSnapshot> {
    const saved = await bridge.save();
    if (!saved) throw new Error('请先完成笔记保存并核对最新草稿。');
    if (expectedRevision !== undefined && saved.revision !== expectedRevision) throw new Error('引用选区的正文版本已变化，请移除引用并重新选取。');
    if (picked && !validNoteSelection(saved.body, picked)) throw new Error('选区已随编辑变化，请重新选取。');
    return prepareNoteContext(noteId, { commandId: newCommandId(), id: newCommandId(), sessionId: id, revision: saved.revision, selection: picked });
  }
  async function deepen(source?: CreateNoteDiscussion['source']) {
    if (!selected || busy) return;
    setBusy(true); setError('');
    try {
      let command = request.current;
      if (!command) {
        if (!source) {
          if (!bridge.selection) throw new Error('请先在正文选择讨论内容。');
          const frozen = await snapshot(selected, bridge.selection);
          source = { kind: 'selection', snapshotId: frozen.id };
        }
        command = { commandId: newCommandId(), sessionId: newCommandId(), parentSessionId: selected, source };
        sessionStorage.setItem(`multivac:note-deepen:${noteId}`, JSON.stringify(command)); request.current = command;
      }
      const child = await deepenNoteDiscussion(noteId, command);
      sessionStorage.removeItem(`multivac:note-deepen:${noteId}`); request.current = null;
      setDiscussions(previous => [...previous.filter(d => d.sessionId !== child.sessionId), child]); activate(child.sessionId);
      bridge.clearSelection(); setOpen(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function referenceSelection() {
    if (!selected || !bridge.selection || busy) return;
    const id = selected, picked = bridge.selection;
    setBusy(true); setError('');
    try { const frozen = await snapshot(id, picked); quote(id, { revision: frozen.revision, selection: picked }); bridge.clearSelection(); setOpen(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function toggle() { setOpen(value => { try { sessionStorage.setItem(`multivac:note-assistant:${noteId}`, value ? 'closed' : 'open'); } catch {} return !value; }); }
  return <div className={`note-assistant-shell ${open ? 'open' : 'closed'}`}>
    {bridge.companionToggleRoot && createPortal(<button type="button" className="note-companion-toggle" aria-pressed={open} onClick={toggle}><MessageSquare size={15} />梳理助手</button>, bridge.companionToggleRoot)}
    {bridge.selection && bridge.selectionToolbarRoot && createPortal(<div className="note-selection-bar" role="toolbar" aria-label="笔记选区操作"><small>已选中 {bridge.selection.text.length} 字</small><button type="button" disabled={busy || !selected} onMouseDown={e => e.preventDefault()} onClick={() => void referenceSelection()}><Quote size={14} />引用给助手</button><button type="button" disabled={busy || !selected} onMouseDown={e => e.preventDefault()} onClick={() => void deepen()}><SquareStack size={14} />深入一层</button></div>, bridge.selectionToolbarRoot)}
    {error && <div role="alert" className="notes-error">{error}<button type="button" disabled={busy} onClick={() => void (request.current ? deepen() : load().catch(e => setError((e as Error).message)))}>重试</button></div>}
    <aside className="note-companion" aria-label="梳理助手" hidden={!open}>
      <header className="note-companion-header"><strong>梳理助手</strong><small>当前笔记 · v{bridge.note.revision}</small></header>
      {!selected && <p className="notes-hint">正在读取讨论…</p>}
      {selected && <nav className="note-discussion-nav" aria-label="笔记讨论层级">
        {discussions.find(d => d.sessionId === selected)?.parentSessionId && <button type="button" disabled={busy} onClick={() => activate(discussions.find(d => d.sessionId === selected)!.parentSessionId!)}><ArrowLeft size={14} />返回上一层</button>}
        <select aria-label="恢复笔记讨论" value={selected} onChange={e => activate(e.target.value)}>{discussions.map(d => <option key={d.sessionId} value={d.sessionId}>{d.parentSessionId ? '深入 · ' : ''}{d.title || '梳理讨论'}</option>)}</select>
      </nav>}
      {discussions.filter(d => visited.has(d.sessionId)).map(d => <NoteThread key={d.sessionId} discussion={d} visible={open && selected === d.sessionId} quote={quotes[d.sessionId] ?? null} clearQuote={() => quote(d.sessionId, null)} snapshot={(picked, revision) => snapshot(d.sessionId, picked, revision)} onDeepen={entryId => void deepen({ kind: 'message', piEntryId: entryId })} suggestions={suggestions?.(d, d.sessionId)} messageActions={messageActions} />)}
    </aside>
  </div>;
}

function NoteThread({ discussion, visible, quote, clearQuote, snapshot, onDeepen, suggestions, messageActions }: { discussion: NoteDiscussion; visible: boolean; quote: DraftQuote | null; clearQuote(): void; snapshot(selection: NoteSelection | null, expectedRevision?: number): Promise<NoteSnapshot>; onDeepen(entryId: string): void; suggestions?: ReactNode; messageActions?: NoteAssistantProps['messageActions'] }) {
  const entry = useAssistantSession(discussion.sessionId), session = entry?.session;
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
  async function send(prompt?: string) {
    if (!session || session.runActive || session.submitting || preparingRef.current || session.pendingSubmission || quote && quote.selection.text.length > 16000) return;
    preparingRef.current = true; setPreparing(true); setError('');
    try {
      if (prompt) {
        if (session.pageState.draft) throw new Error('请先发送或处理当前提问草稿，再使用快捷提问。');
        session.updateDraft(prompt);
      }
      const draft = session.pageState.draft;
      // 给控制器一轮渲染更新快捷提问；用户正文在准备期间仍可编辑，submitDraft 使用控制器实际草稿。
      if (!prompt && !draft.trim()) return;
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
    {discussion.topic && <div className="note-quote"><small>固定讨论主题 · 与当前正文版本分别保存</small><pre>{discussion.topic.text}</pre></div>}
    {session?.initialError && <div className="notes-error" role="alert">{session.initialError}<button type="button" onClick={session.reload}>重试读取讨论</button></div>}
    <div className="note-companion-thread" ref={thread} onScroll={e => { const element = e.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }}>
      {session?.hasMore && <button type="button" disabled={session.loadingEarlier} onClick={() => { follow.current = false; session.loadEarlier(); }}>更早的消息</button>}
      {session?.historyError && <p role="alert">{session.historyError}</p>}
      {!messages.length && <p className="notes-hint">围绕这篇笔记整理结构、润色与讨论已有内容间的联系。修改建议由你逐条决定。</p>}
      {messages.map(message => <article className={`note-message ${message.role}`} key={message.id}><strong>{message.role === 'user' ? '你' : '梳理助手'}</strong>{message.noteContext && <small>正文 v{message.noteContext.revision}{message.noteContext.selection ? ' · 带选区' : ''}</small>}<MarkdownBody identity={message.id} text={message.text} />{message.noteContext && !session?.runActive && <button type="button" onClick={() => onDeepen(message.piEntryId)}><SquareStack size={13} />深入一层</button>}{messageActions?.(message, discussion.sessionId, Boolean(message.noteContext && !session?.runActive))}</article>)}
      {suggestions}
    </div>
    {(error || session?.sendError || session && ['failed', 'unknown'].includes(session.runFeedback.phase)) && <div className="notes-error" role="alert">{error || session?.sendError || session?.runFeedback.message}</div>}
    {session?.pendingSubmission?.unknown && <div className="notes-error"><span>发送结果未知，保留原命令和正文快照。</span><button type="button" onClick={() => void session.checkPendingSubmission()}>核对结果</button><button type="button" onClick={() => void session.retryUnknownSubmission()}>按原命令重试</button></div>}
    {session?.failedSubmissions.map(failure => <div className="notes-error" role="alert" key={failure.commandId}><p>{failure.text}</p><p>{failure.error}</p><button type="button" disabled={session.runActive || !!session.pendingSubmission} onClick={() => void session.retryFailedSubmission(failure.commandId)}>重试这次提问</button><button type="button" onClick={() => { if (!session.restoreFailedSubmission(failure.commandId)) setError('请先处理当前提问草稿。'); }}>恢复提问草稿</button></div>)}
    <div className="note-quick-actions">{['整理结构', '润色', '梳理关联', '生成修改建议'].map(prompt => <button type="button" key={prompt} disabled={!session || session.status !== 'ready' || preparing || session.runActive || !!session.pendingSubmission || !session.model.available || session.model.busy} onClick={() => void send(prompt === '梳理关联' ? '仅梳理当前笔记已有内容之间的联系，不查找或编造其他对象。' : prompt === '生成修改建议' ? '请基于本轮笔记正文生成结构化修改建议，使用约定的JSON代码块。只建议，不修改正文。' : prompt)}>{prompt}</button>)}</div>
    <form className="note-companion-composer" onSubmit={e => { e.preventDefault(); void send(); }}>
      {quote && <div className="note-quote"><small>选区引用 · 来源 v{quote.revision} · 发送时重新核对当前保存正文</small><pre>{quote.selection.text}</pre><button type="button" aria-label="移除笔记选区引用" onClick={clearQuote}><X size={13} /></button></div>}
      <textarea ref={composer} aria-label="向梳理助手提问" placeholder="讨论这篇笔记…" maxLength={12000} value={session?.pageState.draft ?? ''} disabled={!session || session.status !== 'ready'} onChange={e => session?.updateDraft(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
      }} />
      <footer>{entry && <SessionModelContext.Provider value={entry.model}><ModelSelector active={visible} running={Boolean(session?.runActive)} compact portal menuId={`note-model-${discussion.sessionId}`} /></SessionModelContext.Provider>}<button type="submit" aria-label="发送给梳理助手" disabled={!session?.canSubmit || session?.runActive || preparing}><Send size={16} /></button>{session?.runActive && <button type="button" aria-label="停止梳理助手" disabled={session.cancelling} onClick={() => void session.cancelCurrentRun()}><Square size={16} /></button>}</footer>
    </form>
    {session?.saveFeedback.phase === 'error' && <div className="notes-error" role="alert">{session.saveFeedback.message}<button type="button" onClick={session.retrySave}>重试保存讨论草稿</button></div>}
  </div>;
}
