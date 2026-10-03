import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { pageIndexForBoundary, validReference } from './reading-state.js';
import { ReadingReference, ReadingSourceTag } from './reading-overlays.jsx';

function ReadingComposer({ level, scope, onLevel, onSend, focusSignal }) {
  const input = useRef(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const resize = () => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(140, Math.max(42, input.current.scrollHeight))}px`; } };
  useLayoutEffect(resize, [level.draft, level.id]);
  useLayoutEffect(() => {
    let width = -1;
    let frame;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.width !== width) { width = entry.contentRect.width; cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); }
    });
    observer.observe(input.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => { if (focusSignal) input.current?.focus(); }, [focusSignal]);
  const send = () => { if (level.draft.trim() && scope && !composing.current) onSend(level.draft); };
  return <form className="reading-composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
    <label className="sr-only" htmlFor="reading-question">向书伴提问</label>
    <textarea ref={input} id="reading-question" value={level.draft} rows={1} placeholder="讨论当前引用…" onChange={(event) => { onLevel({ ...level, draft: event.target.value }); resize(); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEnded.current = Date.now(); }} onKeyDown={(event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || Date.now() - compositionEnded.current < 50) return;
        event.preventDefault(); send();
      }
    }} />
    <button type="submit" className="primary" disabled={!level.draft.trim() || !scope} aria-label="发送给书伴"><Send /><span>发送</span></button>
    <small>Enter 发送 · Shift+Enter 换行 · 示例回复</small>
  </form>;
}

export function ReadingCompanion({ book, state, reading, pages, visible, pageReference, onLocate, onNote, onHandOver, focusSignal }) {
  const level = state.stack.at(-1);
  const scope = level.quote || level.followup?.reference || level.context || pageReference;
  const scopeLabel = level.quote ? '选区' : level.followup ? '继续追问' : level.context ? '单独讨论' : '当前页';
  const messages = useRef(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      messages.current.scrollTop = Number.isFinite(level.scrollTop) ? level.scrollTop : messages.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, level.id, level.thread.length]);
  const update = (next) => reading.updateLevel(book.id, () => next);
  const boundaryPage = state.readBoundary ? pageIndexForBoundary(book, pages, state.readBoundary) + 1 : null;
  return <div className="reading-companion-session">
    <header className="reading-companion-header">
      <strong>共读讨论 <small>模拟回复</small></strong>
      {state.stack.length > 1 && <button type="button" className="text-button" onClick={() => reading.back(book.id)}><ArrowLeft />返回上层 · {state.stack.length - 1} 层</button>}
      {state.stack.length > 1 && <span className="reading-level-title">{level.title}</span>}
      {state.archived.some((item) => item.parentId === level.id) && <details className="reading-archived"><summary>独立讨论记录</summary><div>{state.archived.filter((item) => item.parentId === level.id).map((item) => <button type="button" key={item.id} className="inline-link" onClick={() => { reading.resumeDiscussion(book.id, item.id); focusSignal.request(); }}>{item.title} · {item.thread.length} 条消息</button>)}</div></details>}
    </header>
    <div className="reading-discussion-scope">
      <details><summary>讨论范围：{scopeLabel}{scope ? ` · ${scope.text.slice(0, 20)}…` : ''}</summary>
        <ReadingReference book={book} reference={scope} onLocate={onLocate} />
        {(level.quote || level.followup) && <button type="button" className="inline-link" onClick={() => update({ ...level, quote: null, followup: null })}>清除引用</button>}
        {scope?.unavailable && <button type="button" className="inline-link" onClick={() => update({ ...level, context: null, quote: null, followup: null })}>改用当前页继续</button>}
        <section className="reading-boundary" aria-label="已读范围"><h3>已读范围</h3><p>{boundaryPage ? `已读到当前排版第 ${boundaryPage} 页末` : '尚未标记已读范围'}</p><p>浏览或跳转不算读完。明确标记后，书伴才据此提醒后文；模拟回复仅按示例章节关键词判断。</p>
          <div className="reading-panel-actions"><button type="button" className="secondary" disabled={!pageReference} onClick={() => reading.patch(book.id, { readBoundary: pageReference.end })}>设为当前页末</button><button type="button" className="text-button" onClick={() => reading.patch(book.id, { readBoundary: null })}>重置已读范围</button></div>
        </section>
        <details className="reading-help"><summary>共读说明</summary><p>新问题围绕当前页或选区；继续追问沿用原讨论。翻页不会发起提问，历史消息保留原引用。</p></details>
      </details>
    </div>
    <div className="reading-messages" ref={messages} onScroll={(event) => {
      const scrollTop = event.currentTarget.scrollTop;
      if (visible && scrollTop !== level.scrollTop) reading.patch(book.id, (current) => ({ ...current, stack: current.stack.map((item) => item.id === level.id ? { ...item, scrollTop } : item) }));
    }}>
      {!level.thread.length && <p className="reading-empty">围绕{scopeLabel}交流：问概念、举例、梳理本页，或与前文联系。翻页不会自动提问。</p>}
      {level.thread.map((message) => <article key={message.id} className={`reading-message ${message.who === '你' ? 'from-reader' : ''}`}>
        <strong>{message.who}</strong>
        {message.who === '你' ? <ReadingReference book={book} reference={message.reference} onLocate={onLocate} compact /> : <ReadingSourceTag book={book} reference={message.reference} onLocate={onLocate} />}
        <p>{message.text.replace(/^示例书伴：/u, '')}</p>
        {message.who === '书伴' && <div className="reading-message-actions">
          {message.handover ? <button type="button" className="secondary" onClick={() => onHandOver(message.handover, message.reference)}>交给 Multivac</button> : <>
            <button type="button" className="inline-link" disabled={!validReference(book, message.reference)} onClick={() => { update({ ...level, quote: null, followup: { messageId: message.id, reference: message.reference } }); focusSignal.request(); }}>继续追问</button>
            <button type="button" className="inline-link" disabled={!validReference(book, message.reference)} onClick={() => { reading.deepen(book.id, message); focusSignal.request(); }}>单独讨论</button>
          </>}
          <button type="button" className="inline-link" onClick={() => onNote(message.reference, message.text, 'companion', { levelId: level.id, messageId: message.id })}>存为阅读笔记</button>
        </div>}
      </article>)}
    </div>
    <ReadingComposer level={level} scope={validReference(book, scope) ? scope : null} onLevel={update} onSend={(question) => reading.ask(book.id, scope, question)} focusSignal={focusSignal.value} />
  </div>;
}
