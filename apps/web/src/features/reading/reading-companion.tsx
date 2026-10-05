import { validBookReference, type ReadingBook } from './reading-book.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Send, Square, Quote, X } from 'lucide-react';
import { type ReadingAdjacentPages, type ReadingReferenceKind, type BookReference, type ReadingDiscussion, type ReadingMessageSource } from '@multivac/contracts';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { SessionModelContext } from '../assistant/session-model.js';
import { ModelSelector } from '../assistant/model-selector.js';

export function ReadingCompanion({ adjacentPages, visible, referenceKind, book, sessionId, reference, pageReference, sourceMessage, discussion, discussions, messageFocus, onActivate, onClearQuote, onLocate, onManageModels }: { adjacentPages: ReadingAdjacentPages; visible: boolean; referenceKind: ReadingReferenceKind; book: ReadingBook; sessionId: string; reference: BookReference | null; pageReference: BookReference | null; sourceMessage: ReadingMessageSource | null; discussion: ReadingDiscussion | null; discussions: ReadingDiscussion[]; messageFocus: { id: number; piEntryId: string } | null; onActivate: (d: ReadingDiscussion) => void; onClearQuote: () => void; onLocate: (r: BookReference) => void; onManageModels?: (() => void) | undefined }) {
  const scopeLabel = { 'current-page': '当前页', selection: '选区', 'follow-up': '继续追问', discussion: '单独讨论' }[referenceKind];
  const entry = useAssistantSession(sessionId);
  const session = entry?.session;
  const runError = session?.sendError || (session && ['failed', 'unknown'].includes(session.runFeedback.phase) ? session.runFeedback.message : '');
  const [error, setError] = useState('');

  const path: ReadingDiscussion[] = [];
  let level = discussion;
  while (level && !path.some(d => d.sessionId === level!.sessionId) && path.length < 16) { path.unshift(level); level = discussions.find(d => d.sessionId === level!.parentSessionId) ?? null; }
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const messages = useRef<HTMLDivElement>(null);
  const messageBody = useRef<HTMLDivElement>(null);
  const focused = useRef<number | null>(null);
  const following = useRef(true);
  const restoredGeneration = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = messages.current; if (!visible || !element || !session) return;
    if (following.current && restoredGeneration.current === session.loadGeneration && !session.loadingEarlier) element.scrollTop = element.scrollHeight;
    else if (session.pageState.anchorEntryId) {
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(e => e.dataset.messageId === session.pageState.anchorEntryId);
      if (target) element.scrollTop = target.offsetTop - session.pageState.anchorOffsetPx;
    } else element.scrollTop = element.scrollHeight;
    restoredGeneration.current = session.loadGeneration;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, [visible, session?.loadGeneration, session?.displayMessages.length]);
  useLayoutEffect(() => {
    if (!visible || !messageBody.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
    });
    observer.observe(messageBody.current); return () => observer.disconnect();
  }, [visible, session?.loadGeneration]);
  useEffect(() => {
    if (!messageFocus || !session || session.status !== 'ready' || focused.current === messageFocus.id) return;
    const target = [...(messages.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(e => e.dataset.messageId === messageFocus.piEntryId);
    if (target && messages.current) { messages.current.scrollTop = target.offsetTop; target.focus(); session.setReadingAnchor(messageFocus.piEntryId, 0); focused.current = messageFocus.id; }
    else if (session.hasMore && !session.loadingEarlier && !session.historyError) session.loadEarlier();
    else if (!session.hasMore || session.historyError) { setError('来源消息已失效或历史读取失败。'); focused.current = messageFocus.id; }
  }, [messageFocus?.id, session?.status, session?.displayMessages.length, session?.loadingEarlier]);
  function send() { if (reference && pageReference && session?.canSubmit && !composing.current) { following.current = true; void session.submitDraft({ contextRefs: [{ kind: 'book', reference: structuredClone(reference), referenceKind, pageReference: structuredClone(pageReference), adjacentPages: structuredClone(adjacentPages), ...(sourceMessage ? { sourceMessage } : {}) }] }); } }
  return <aside className="reading-companion" aria-label="书伴">
    {path.length > 1 && <nav className="reading-discussion-path" aria-label="讨论路径">{path.map((d, i) => <button key={d.sessionId} aria-current={d.sessionId === sessionId ? 'true' : undefined} onClick={() => onActivate(d)} title={d.title}>{i > 0 && ' / '}{d.title}</button>)}</nav>}
    {error && <div role="alert">{error}</div>}

    {session?.initialError && <div className="reading-companion-error" role="alert"><p>{session.initialError}</p><div><button className="reading-command" onClick={session.reload}>重试读取</button>{onManageModels && <button className="reading-command" onClick={onManageModels}>管理模型配置</button>}</div></div>}
    <div ref={messages} className="reading-messages" onScroll={event => {
      if (!visible || !session) return;
      const element = event.currentTarget;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      const target = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find(e => e.offsetTop + e.offsetHeight > element.scrollTop);
      if (target) session.setReadingAnchor(target.dataset.messageId!, target.offsetTop - element.scrollTop);
    }}>
      {session?.hasMore && <button disabled={session.loadingEarlier} onClick={() => { following.current = false; session.loadEarlier(); }}>更早的消息</button>}{session?.historyError && <p role="alert">{session.historyError}</p>}
      <div ref={messageBody} className="reading-message-list">
      {session?.timeline.map(item => {
        if (item.kind === 'trace') return null;
        const message = item.message;
        return <article tabIndex={-1} data-message-id={message.piEntryId} key={message.id} className={`reading-message ${message.role}`}><strong>{message.role === 'user' ? '你' : '书伴'}</strong>{'readingReference' in message && message.readingReference && <button title={message.readingReference.text} aria-label="定位消息引用原文" className="reading-source" disabled={!validBookReference(book, message.readingReference)} onClick={() => onLocate(message.readingReference!)}><Quote size={12} aria-hidden="true" /><span>{message.readingReference.text}</span></button>}<MarkdownBody identity={message.id} text={message.text} /></article>; })}
      </div>
    </div>
    {runError && <p role="alert">{runError}</p>}

    <form className="reading-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      {reference && referenceKind !== 'current-page' && <div className="reading-context-preview">
        <button type="button" className="reading-context-source" aria-label="定位待发送原文" title={reference.text} onClick={() => onLocate(reference)}><Quote size={14} aria-hidden="true" /><span><strong>{scopeLabel === '当前页' ? '当前页原文' : scopeLabel === '选区' ? '引用原文' : scopeLabel}<small>{scopeLabel !== '当前页' && ' · 同时附上当前页'}</small></strong><span>{reference.text}</span></span></button>
        {scopeLabel !== '当前页' && scopeLabel !== '单独讨论' && <button type="button" className="reading-icon" aria-label="取消引用，改用当前页" title="取消引用，改用当前页" onClick={onClearQuote}><X size={14} /></button>}
      </div>}
      {!pageReference && <span className="reading-context-loading" role="status">正在读取当前页原文…</span>}
      <textarea aria-label="向书伴提问" placeholder="围绕当前内容提问…" rows={3} value={session?.pageState.draft ?? ''} disabled={!session || session.status !== 'ready'} onChange={event => session?.updateDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now(); }} onKeyDown={event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229 && Date.now() - compositionEnded.current > 50) { event.preventDefault(); send(); }
    }} /><div className="reading-composer-footer">{entry && <div className="reading-model-controls"><SessionModelContext.Provider value={entry.model}><ModelSelector active={visible} running={Boolean(session?.runActive)} compact portal onManage={onManageModels} menuId={`reading-model-${sessionId}`} /></SessionModelContext.Provider></div>}<div className="reading-send-actions"><button className="reading-command" title="发送给书伴" aria-label="发送给书伴" disabled={!reference || !pageReference || !session?.canSubmit}><Send size={18} /></button>{session?.runActive && <button type="button" className="reading-command" title="停止书伴" aria-label="停止书伴" disabled={session.cancelling} onClick={() => void session.cancelCurrentRun()}><Square size={16} /></button>}</div></div></form>
    {session?.saveFeedback.phase === 'error' && <div role="alert">{session.saveFeedback.message}<button onClick={session.retrySave}>重试保存草稿</button></div>}
  </aside>;
}
