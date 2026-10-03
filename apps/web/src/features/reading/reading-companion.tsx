import { useEffect, useRef, useState } from 'react';
import { Send, Square, ArrowLeft } from 'lucide-react';
import { validBookReference, type Book, type BookReference, type ReadingScope, type ReadingScopeCommand } from '@multivac/contracts';
import { getReadingScope, setReadingScope } from '../../data/reading-api.js';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function ReadingCompanion({ book, sessionId, reference, pageReference, onClearQuote, onLocate }: { book: Book; sessionId: string; reference: BookReference | null; pageReference: BookReference | null; onClearQuote: () => void; onLocate: (r: BookReference) => void }) {
  const entry = useAssistantSession(sessionId);
  const session = entry?.session;
  const [scope, setScope] = useState<ReadingScope | null>(null);
  const [error, setError] = useState('');
  const [pendingScope, setPendingScope] = useState<ReadingScopeCommand | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const messages = useRef<HTMLDivElement>(null);
  const refreshScope = () => getReadingScope(book.id).then(next => setScope(current => !current || next.revision >= current.revision ? next : current)).catch(e => setError((e as Error).message));
  useEffect(() => { void refreshScope(); }, [book.id]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === book.id) void refreshScope(); });
  useEffect(() => {
    const element = messages.current; if (!element || !session) return;
    if (session.pageState.anchorEntryId) {
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(e => e.dataset.messageId === session.pageState.anchorEntryId);
      if (target) element.scrollTop = target.offsetTop - session.pageState.anchorOffsetPx;
    } else element.scrollTop = element.scrollHeight;
  }, [session?.loadGeneration, session?.displayMessages.length]);
  async function boundary(command: ReadingScopeCommand) {
    if (scopeBusy) return; setScopeBusy(true); setError(''); setPendingScope(command);
    try { setScope(await setReadingScope(book.id, command)); setPendingScope(null); }
    catch (e) { setError((e as Error).message); }
    finally { setScopeBusy(false); }
  }
  function send() { if (reference && session?.canSubmit && !composing.current) void session.submitDraft({ contextRefs: [{ kind: 'book', reference: structuredClone(reference) }] }); }
  return <aside className="reading-companion" aria-label="书伴">
    <header><strong>共读讨论</strong><small>{entry?.model.data?.selection.profileId ?? ''}</small></header>
    <details className="reading-scope"><summary>讨论范围 · {reference ? reference.text.slice(0, 24) : '原文不可用'}</summary><blockquote>{reference?.text}</blockquote><button className="reading-command" disabled={!reference || !validBookReference(book, reference)} onClick={() => reference && onLocate(reference)}><ArrowLeft size={16} />定位原文</button>
      <p>{scope?.boundary ? `已读到 ${book.chapters.find(c => c.id === scope.boundary?.chapterId)?.title} · 字符 ${scope.boundary.offset}` : '尚未标记已读范围'}</p>
      <button onClick={onClearQuote}>改用当前页</button><button disabled={!scope || !pageReference || scopeBusy || Boolean(pendingScope)} onClick={() => scope && pageReference && void boundary({ commandId: crypto.randomUUID(), expectedRevision: scope.revision, boundary: pageReference.end })}>已读到当前页末</button><button disabled={!scope?.boundary || scopeBusy || Boolean(pendingScope)} onClick={() => scope && void boundary({ commandId: crypto.randomUUID(), expectedRevision: scope.revision, boundary: null })}>重置已读范围</button>
    </details>
    {error && <div role="alert">{error}{pendingScope && <><button disabled={scopeBusy} onClick={() => void boundary(pendingScope)}>重试原命令</button><button onClick={() => { setPendingScope(null); void refreshScope(); }}>重新读取范围</button></>}</div>}
    {session?.initialError && <div role="alert">{session.initialError}<button onClick={session.reload}>重试读取</button></div>}
    <div ref={messages} className="reading-messages" onScroll={event => {
      if (!session) return;
      const element = event.currentTarget;
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(e => e.offsetTop + e.offsetHeight > element.scrollTop);
      if (target) session.setReadingAnchor(target.dataset.messageId!, target.offsetTop - element.scrollTop);
    }}>
      {session?.displayMessages.map(message => <article data-message-id={message.piEntryId} key={message.id} className="reading-message"><strong>{message.role === 'user' ? '你' : '书伴'}</strong>{'readingReference' in message && message.readingReference && <button className="reading-source" disabled={!validBookReference(book, message.readingReference)} onClick={() => onLocate(message.readingReference!)}>{message.readingReference.text.slice(0, 42)}</button>}<MarkdownBody identity={message.id} text={message.text} /></article>)}
    </div>
    {session?.runFeedback.message && <p role="status">{session.runFeedback.message}</p>}
    {session?.sendError && <p role="alert">{session.sendError}</p>}
    <form className="reading-composer" onSubmit={event => { event.preventDefault(); send(); }}><textarea aria-label="向书伴提问" rows={3} value={session?.pageState.draft ?? ''} disabled={!session || session.status !== 'ready'} onChange={event => session?.updateDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now(); }} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229 && Date.now() - compositionEnded.current > 50) { event.preventDefault(); send(); }
    }} /><button className="reading-command" title="发送给书伴" aria-label="发送给书伴" disabled={!reference || !session?.canSubmit}><Send size={18} /></button>{session?.runActive && <button type="button" className="reading-command" title="停止书伴" aria-label="停止书伴" disabled={session.cancelling} onClick={() => void session.cancelCurrentRun()}><Square size={16} /></button>}</form>
    {session?.saveFeedback.phase === 'error' && <div role="alert">{session.saveFeedback.message}<button onClick={session.retrySave}>重试保存草稿</button></div>}
  </aside>;
}
