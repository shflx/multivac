import { useEffect, useId, useRef, useState } from 'react';
import './session-agent.css';
import { AtSign, X } from 'lucide-react';
import type { AgentList } from '@multivac/contracts';
import { listAgents } from '../../data/agent-api.js';
import type { AssistantSession } from './assistant-session.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export interface AgentPickerRequest { id: number; draft: string; offset: number }

/** 候选名称只用于搜索和展示；用户明确选择后才写入稳定 agentId。 */
export function WorkSessionAgentPicker({ session, request, focusComposer }: {
  session: AssistantSession; request: AgentPickerRequest | null; focusComposer(): void;
}) {
  const [options, setOptions] = useState<AgentList | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const generation = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const typedTrigger = useRef<AgentPickerRequest | null>(null);
  const menuId = useId();
  const locked = session.runBusy || session.submitting;
  const load = async () => {
    const current = ++generation.current;
    setLoading(true); setError('');
    try { const next = await listAgents(); if (generation.current === current) setOptions(next); }
    catch (reason) { if (generation.current === current) setError(reason instanceof Error ? reason.message : '智能体列表读取失败。'); }
    finally { if (generation.current === current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { generation.current++; }; }, []);
  useOptionalWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'agent.changed') void load(); });
  useEffect(() => {
    if (!request || locked) return;
    typedTrigger.current = request; setQuery(''); setIndex(0); setOpen(true); void load();
  }, [request?.id]);
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  const candidates = options?.agents.filter(agent => !agent.fixed && agent.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  const selected = options?.agents.find(agent => agent.agentId === session.pageState.agentId);
  const preview = session.pageState.agentId ? options?.invocations?.[session.pageState.agentId] : undefined;
  const close = () => { setOpen(false); typedTrigger.current = null; focusComposer(); };
  const choose = (agentId: string) => {
    if (locked || !options?.invocations?.[agentId]?.executor) return;
    const trigger = typedTrigger.current;
    if (trigger && session.pageState.draft === trigger.draft && trigger.draft[trigger.offset] === '@') {
      session.updateDraft(trigger.draft.slice(0, trigger.offset) + trigger.draft.slice(trigger.offset + 1));
    }
    session.setAgentId(agentId); close();
  };
  return <div className="work-session-agent-picker">
    <button type="button" className="agent-invoke-button" aria-label="选择本轮智能体" aria-expanded={open} aria-controls={menuId} disabled={locked}
      onClick={() => { typedTrigger.current = null; setQuery(''); setIndex(0); setOpen(!open); void load(); }}><AtSign aria-hidden="true" /><span>智能体</span></button>
    {session.pageState.agentId && <div className="agent-invoke-chip" aria-label="本轮智能体">
      <span><strong>@{selected?.name ?? (options ? '智能体已失效' : '读取中…')}</strong>
        <small>{preview?.executor ? `本轮 · ${preview.executor.modelName} · ${preview.executor.thinkingLevel}` : preview?.error ?? (loading ? '正在核对本轮模型' : '模型待核对')}</small></span>
      <button type="button" aria-label="移除本轮智能体" disabled={locked} onClick={() => { session.setAgentId(null); focusComposer(); }}><X aria-hidden="true" /></button>
    </div>}
    {open && <div className="agent-invoke-menu" id={menuId} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <label>选择本轮智能体<input ref={search} aria-label="搜索执行智能体" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }}
        aria-controls={`${menuId}-options`} aria-activedescendant={candidates[index] ? `${menuId}-${index}` : undefined}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, Math.min(candidates.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') { event.preventDefault(); const agent = candidates[index]; if (agent) choose(agent.agentId); }
        }} /></label>
      {loading && <p role="status">正在读取智能体…</p>}
      {error && <p role="alert">{error}<button type="button" onClick={() => void load()}>重试</button></p>}
      <div id={`${menuId}-options`} role="listbox" aria-label="执行智能体">
        {candidates.map((agent, position) => {
          const invocation = options?.invocations?.[agent.agentId];
          const available = Boolean(invocation?.executor);
          return <button key={agent.agentId} id={`${menuId}-${position}`} type="button" role="option" aria-selected={position === index} aria-disabled={!available}
            onMouseEnter={() => setIndex(position)} onClick={() => choose(agent.agentId)}>
            <strong>{agent.name}</strong><small>{invocation?.executor ? `${invocation.executor.modelName} · ${invocation.executor.thinkingLevel}` : invocation?.error ?? '模型无法核对'}</small>
          </button>;
        })}
      </div>
      {!loading && !error && !candidates.length && <p>没有匹配的执行智能体</p>}
      <p className="agent-invoke-hint">使用当前会话上下文，仅指定本轮执行者。</p>
    </div>}
  </div>;
}
