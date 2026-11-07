import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Bot, CircleAlert, Forward, Info, LoaderCircle } from 'lucide-react';
import { SubagentProcessPageSchema, type SubagentListItem, type SubagentProcessEntry, type SubagentProcessPage } from '@multivac/contracts';
import { ToolExecutionGroup } from '../assistant/tool-execution.js';
import { fetchJson } from '../../data/assistant-api.js';
import { MarkdownBody } from '../assistant/markdown-body.js';
import { focusableWithin, wrapFocusIndex } from '../../components/focus-trap.js';
import { SUBAGENT_STATES } from './subagent-labels.js';
import { delegationMarkdown, subagentOutcome, subagentTimeline } from './subagent-timeline.js';

/** 距底部多少像素以内视为贴近底部，运行中的新过程继续跟随。 */
const FOLLOW_THRESHOLD_PX = 24;

/** 子智能体的回复按普通会话的助手消息呈现。 */
function Reply({ entry, item }: { entry: SubagentProcessEntry; item: SubagentListItem }) {
  return (
    <article className="chat-row assistant">
      <span className="avatar" aria-hidden="true"><Bot /></span>
      <div className="chat-content">
        <span className="message-author">{item.agent.name}</span>
        <MarkdownBody text={entry.text} identity={`${item.id}:${entry.id}`} />
      </div>
    </article>
  );
}

/** 委派输入沿用用户气泡；来源写在气泡上方，过长时默认收起。 */
function DelegationInput({ entry, item }: { entry: SubagentProcessEntry; item: SubagentListItem }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [entry.text, expanded]);
  return (
    <article className="chat-row user subagent-input">
      <span className="avatar" aria-hidden="true"><Forward /></span>
      <div className="chat-content">
        <span className="subagent-input-source">来自「{item.parentTitle}」的委派</span>
        <div ref={body} className={`subagent-input-body${expanded ? '' : ' clamped'}`}>
          <MarkdownBody text={delegationMarkdown(entry.text)} identity={`${item.id}:${entry.id}`} />
        </div>
        {(overflows || expanded) && <button type="button" className="inline-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全部'}</button>}
      </div>
    </article>
  );
}

/**
 * 子智能体的只读会话：按普通对话呈现完整过程，输入区换成只读说明。
 * 子智能体会话是一次冻结委派，只由委派器推进，这里不提供发送入口。
 */
export function SubagentSessionView({ item, onClose }: { item: SubagentListItem; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null), previous = useRef(document.activeElement);
  const scrollRef = useRef<HTMLDivElement>(null), followRef = useRef(false);
  const [page, setPage] = useState<SubagentProcessPage | null>(null), [error, setError] = useState('');
  const [loaded, setLoaded] = useState(100);
  const running = !item.stopConfirmed;

  useLayoutEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let disposed = false, request: AbortController | null = null;
    async function read() {
      request?.abort(); const controller = new AbortController(); request = controller;
      try {
        const items: SubagentProcessPage['items'] = []; let result: SubagentProcessPage | null = null;
        for (let offset = 0; offset < loaded; offset += 100) {
          result = await fetchJson(`/api/subagents/${encodeURIComponent(item.id)}/process?offset=${offset}&limit=100`, { signal: controller.signal }, SubagentProcessPageSchema);
          items.push(...result.items); if (result.nextOffset === null) break;
        }
        if (!disposed && !controller.signal.aborted && result) { setPage({ ...result, items }); setError(''); }
      } catch (error) { if (!disposed && !controller.signal.aborted) setError(error instanceof Error ? error.message : '过程读取失败。'); }
    }
    void read(); const timer = running ? setInterval(() => void read(), 1500) : null;
    return () => { disposed = true; request?.abort(); if (timer) clearInterval(timer); };
  }, [item.id, running, loaded]);

  // 运行中贴近底部时跟随新过程；用户上翻阅读后不再拉回。
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && followRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [page]);

  const timeline = subagentTimeline(item, page?.items ?? []);
  const outcome = subagentOutcome(item);

  return createPortal(
    <div className="subagent-session" ref={root} role="dialog" aria-modal="true" aria-label="子智能体会话"
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key === 'Tab') { const items = focusableWithin(event.currentTarget); const next = wrapFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey); if (next !== null) { event.preventDefault(); items[next]?.focus(); } }
      }}>
      <header className="subagent-session-header">
        <button type="button" className="icon-button" aria-label="关闭子智能体会话" title="返回" onClick={onClose}><ArrowLeft aria-hidden="true" /></button>
        <strong className="subagent-session-title" title={`子智能体 ${item.agent.name}`}>{item.agent.name}</strong>
        <span className={`subagent-state ${item.status}`}>{SUBAGENT_STATES[item.status]}</span>
      </header>

      <section className="assistant-conversation" aria-label="子智能体过程">
        <div className="message-scroll" ref={scrollRef} tabIndex={0} onScroll={event => {
          const scroll = event.currentTarget;
          followRef.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= FOLLOW_THRESHOLD_PX;
        }}>
          <div className="message-stream">
            {error && <p className="subagent-session-state" role="alert">{error}</p>}
            {!page && !error && <p className="subagent-session-state" role="status">正在读取过程…</p>}
            {page && !page.available && <p className="subagent-session-state" role="status">过程暂时不可读；未重新启动执行。</p>}
            {timeline.input && <DelegationInput entry={timeline.input} item={item} />}
            {timeline.trace && <ToolExecutionGroup records={timeline.records} trace={timeline.trace} replyVisible={!!timeline.reply} />}
            {timeline.reply && <Reply entry={timeline.reply} item={item} />}
            {outcome && <p className={`subagent-outcome ${item.status}`} role="status"><CircleAlert aria-hidden="true" />{outcome}</p>}
            {page?.nextOffset !== null && page?.nextOffset !== undefined && <button type="button" className="load-earlier" onClick={() => setLoaded(loaded + 100)}>读取后续过程</button>}
          </div>
        </div>

        <div className="assistant-composer task-readonly">
          <p className="task-session-notice">
            {running ? <LoaderCircle className="spin" aria-hidden="true" /> : <Info aria-hidden="true" />}
            {running ? '执行中，结论会交回父会话' : '已结束'} · 子智能体会话只读，不能继续对话
          </p>
        </div>
      </section>
    </div>,
    document.body,
  );
}
