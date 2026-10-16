import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './session-agent.css';
import { AtSign, Check, CircleAlert, LoaderCircle, RefreshCw, Search, SearchX, X } from 'lucide-react';
import { useAgentList } from '../agents/use-agents.js';
import { MultivacIcon } from '../../components/multivac-icon.js';
import { THINKING_LEVEL_LABELS } from '../models/model-profile-view.js';
import type { AssistantSession } from './assistant-session.js';

export interface AgentPickerRequest { id: number; draft: string; offset: number }

/** 候选名称只用于搜索和展示；用户明确选择后才写入稳定 agentId。 */
export function WorkSessionAgentPicker({ session, request, mentionTarget, focusComposer }: {
  session: AssistantSession; request: AgentPickerRequest | null; mentionTarget: HTMLElement | null; focusComposer(): void;
}) {
  const { data: options, error, loading, load } = useAgentList();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const typedTrigger = useRef<AgentPickerRequest | null>(null);
  const menuId = useId();
  const locked = session.runBusy || session.submitting;
  useEffect(() => {
    if (!request || locked) return;
    typedTrigger.current = request; setQuery(''); setIndex(0); setOpen(true); void load();
  }, [request?.id]);
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  useLayoutEffect(() => {
    if (!open) return;
    const popup = menu.current;
    const composer = popup?.closest<HTMLElement>('.assistant-composer');
    if (!popup || !composer) return;
    const conversation = composer.closest<HTMLElement>('.assistant-conversation');
    // 高度只取输入卡片上方的可见空间；引用、附件或窗口尺寸变化后重新核对。
    const position = () => {
      const top = Math.max(window.visualViewport?.offsetTop ?? 0, conversation?.getBoundingClientRect().top ?? 0);
      popup.style.maxHeight = `${Math.max(0, Math.min(420, composer.getBoundingClientRect().top - top - 20))}px`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(composer);
    if (conversation) observer.observe(conversation);
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  useEffect(() => { if (open) search.current?.focus({ preventScroll: true }); }, [open]);
  const candidates = options?.agents.filter(agent => !agent.fixed && agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  useEffect(() => { if (open) activeOption.current?.scrollIntoView({ block: 'nearest' }); }, [open, index, query]);
  const selected = options?.agents.find(agent => agent.agentId === session.pageState.agentId);
  const selectedName = session.pageState.agentId ? selected?.name ?? (options ? '智能体已失效' : '读取中…') : null;
  useLayoutEffect(() => {
    const area = mentionTarget?.parentElement;
    const input = area?.querySelector('textarea');
    if (!area || !input || !mentionTarget) return;
    // 原生输入框只在第一行给提及让位，保留正文的输入法、粘贴与选区行为。
    const position = () => {
      area.style.setProperty('--composer-agent-indent', `${selectedName ? mentionTarget.offsetWidth + 8 : 0}px`);
      mentionTarget.style.transform = `translateY(${-input.scrollTop}px)`;
    };
    const observer = new ResizeObserver(position);
    observer.observe(mentionTarget);
    observer.observe(area);
    input.addEventListener('scroll', position);
    position();
    return () => {
      observer.disconnect();
      input.removeEventListener('scroll', position);
      area.style.removeProperty('--composer-agent-indent');
    };
  }, [mentionTarget, selectedName]);
  const close = () => { setOpen(false); typedTrigger.current = null; focusComposer(); };
  const toggle = () => {
    if (open) { close(); return; }
    typedTrigger.current = null; setQuery(''); setIndex(0); setOpen(true); void load();
  };
  const remove = () => { if (!locked) { session.setAgentId(null); close(); } };
  const choose = (agentId: string) => {
    if (locked || !options?.invocations?.[agentId]?.executor) return;
    const trigger = typedTrigger.current;
    if (trigger && session.pageState.draft === trigger.draft && trigger.draft[trigger.offset] === '@') {
      session.updateDraft(trigger.draft.slice(0, trigger.offset) + trigger.draft.slice(trigger.offset + 1));
    }
    session.setAgentId(agentId); close();
  };
  return <>
    {selectedName && mentionTarget && createPortal(
      <div className="composer-agent-mention" role="group" aria-label="本轮智能体" onKeyDown={event => {
        if ((event.key === 'Backspace' || event.key === 'Delete') && !event.nativeEvent.isComposing) { event.preventDefault(); remove(); }
      }}>
        <button type="button" className="composer-agent-name" aria-label="更换本轮智能体" aria-describedby={`${menuId}-name`} aria-expanded={open} aria-controls={menuId} aria-keyshortcuts="Backspace Delete" title={`本轮智能体：${selectedName}，点击切换`} disabled={locked} onMouseDown={event => { if (open) event.preventDefault(); }} onClick={toggle}>
          <MultivacIcon /><span id={`${menuId}-name`}>{selectedName}</span>
        </button>
        <button type="button" className="composer-agent-remove" aria-label="移除本轮智能体" title="移除智能体" disabled={locked} onClick={remove}><X aria-hidden="true" /></button>
      </div>, mentionTarget,
    )}
    <div className="work-session-agent-picker">
    <button type="button" className="agent-invoke-button" aria-label="选择本轮智能体" aria-expanded={open} aria-controls={menuId} title="选择本轮智能体" disabled={locked}
      onMouseDown={event => { if (open) event.preventDefault(); }} onClick={toggle}><AtSign aria-hidden="true" /><span>智能体</span></button>
    {open && <div ref={menu} className="agent-invoke-menu" id={menuId} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <div className="agent-invoke-heading"><strong>选择智能体</strong><span>后续消息沿用</span></div>
      <div className="agent-invoke-search">
        <Search aria-hidden="true" />
        <input ref={search} aria-label="搜索执行智能体" placeholder="搜索智能体…" autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }}
        aria-controls={`${menuId}-options`} aria-activedescendant={candidates[index] ? `${menuId}-${index}` : undefined}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, Math.min(candidates.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); const agent = candidates[index]; if (agent) choose(agent.agentId); }
        }} />
        {loading ? <LoaderCircle className="spin" aria-label="正在读取智能体" role="status" /> : query && <button type="button" aria-label="清空搜索" onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(''); setIndex(0); search.current?.focus(); }}><X aria-hidden="true" /></button>}
      </div>
      {error && <div className="agent-invoke-error" role="alert"><CircleAlert aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" />重试</button></div>}
      <div className="agent-invoke-options" id={`${menuId}-options`} role="listbox" aria-label="执行智能体" aria-busy={loading}>
        {candidates.map((agent, position) => {
          const invocation = options?.invocations?.[agent.agentId];
          const available = Boolean(invocation?.executor);
          return <button key={agent.agentId} id={`${menuId}-${position}`} ref={position === index ? activeOption : undefined} type="button" role="option" aria-selected={agent.agentId === session.pageState.agentId} aria-disabled={!available} data-active={position === index}
            onMouseEnter={() => setIndex(position)} onClick={() => choose(agent.agentId)}>
            <span className="agent-option-icon"><MultivacIcon /></span>
            <span className="agent-option-copy"><strong>{agent.name}</strong><small>{invocation?.executor ? <><span className="agent-option-model">{invocation.executor.modelName}</span><span className="agent-option-thinking">推理{THINKING_LEVEL_LABELS[invocation.executor.thinkingLevel]}</span></> : invocation?.error ?? '模型无法核对'}</small></span>
            {!available ? <CircleAlert className="agent-option-status" aria-label="模型待核对" /> : agent.agentId === session.pageState.agentId ? <Check className="agent-option-status" aria-label="已选择" /> : null}
          </button>;
        })}
      </div>
      {!loading && !error && !candidates.length && <div className="agent-invoke-empty"><SearchX aria-hidden="true" /><strong>{query.trim() ? '没有找到匹配的智能体' : '暂无可用智能体'}</strong><span>{query.trim() ? '试试其他名称或清空搜索' : '可在设置中添加执行智能体'}</span></div>}
      <div className="agent-invoke-footer"><span>沿用当前会话上下文</span><span className="agent-invoke-keys" aria-hidden="true"><span><kbd>↑↓</kbd>切换</span><span><kbd>↵</kbd>选择</span><span><kbd>esc</kbd>关闭</span></span></div>
    </div>}
    </div>
  </>;
}
