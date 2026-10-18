import { useEffect, useRef, useState } from 'react';
import type { McpRule, McpRuleTarget, McpScopeEntry } from '@multivac/contracts';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { MCP_EFFECTS, MCP_EFFECT_LABELS, mcpApi, mcpCommand, mcpStateLabel } from './mcp-api.js';
import './mcp.css';

/** 项目、智能体和会话使用同一规则入口；草稿与最新版本分开，冲突不能覆盖输入。 */
export function McpScope({ kind, id, active = true }: { kind: McpRuleTarget['kind']; id: string; active?: boolean }) {
  const [entries, setEntries] = useState<McpScopeEntry[]>([]), [error, setError] = useState('');
  const generation = useRef(0);
  async function load() {
    const read = ++generation.current;
    try { const result = await mcpApi<McpScopeEntry[]>(`/scope?kind=${kind}&id=${encodeURIComponent(id)}`); if (read === generation.current) { setEntries(result); setError(''); } }
    catch (cause) { if (read === generation.current) setError((cause as Error).message); }
  }
  useEffect(() => { setEntries([]); if (active) void load(); return () => { generation.current++; }; }, [kind, id, active]);
  useOptionalWorkbenchEvents(event => { if (active && ['mcp.changed', 'workbench.connected', 'session.changed'].includes(event.type)) void load(); });
  return <section className="detail-section mcp-scope" aria-label="MCP 服务规则">
    <div className="section-title"><h3>MCP 服务与工具</h3><button type="button" className="inline-link" onClick={() => void load()}>核对最新规则</button></div>
    <p className="section-hint">{kind === 'project' ? '项目可以排除服务并明确选择账号。账号未选择时，不自动回落到其他账号。' : kind === 'agent' ? '偏好只调整顺序。效果上限与项目、会话和宿主限制共同生效。' : '临时停用持续到本会话明确重新启用；刷新、重启和归档恢复不会清除它。'} 每次实际调用仍需要单次许可。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!entries.length && !error && <p className="section-hint">尚无已登记服务，或正在读取。</p>}
    {entries.map(entry => <ScopeRow key={`${kind}:${id}:${entry.service.serviceId}`} entry={entry} kind={kind} ownerId={id} reload={load} />)}
  </section>;
}
function ScopeRow({ entry, kind, ownerId, reload }: { entry: McpScopeEntry; kind: McpRuleTarget['kind']; ownerId: string; reload: () => Promise<void> }) {
  const empty: McpRuleTarget = kind === 'project' ? { kind, projectId: ownerId, excluded: false, accountId: null } : kind === 'agent' ? { kind, agentId: ownerId, preferred: false, effectCeiling: [...MCP_EFFECTS] } : { kind, sessionId: ownerId, disabled: false };
  const [draft, setDraft] = useState(entry.rule?.target ?? empty), [base, setBase] = useState(entry.rule?.revision ?? 0), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!dirty) { setDraft(entry.rule?.target ?? empty); setBase(entry.rule?.revision ?? 0); } }, [entry.rule, dirty]);
  function change(target: McpRuleTarget) { setDraft(target); setDirty(true); setError(''); }
  async function save() {
    setBusy(true); setError('');
    try { const rule = await mcpApi<McpRule>('/rule', { commandId: mcpCommand(), serviceId: entry.service.serviceId, revision: base, target: draft }); setBase(rule.revision); setDraft(rule.target); setDirty(false); await reload(); }
    catch (cause) { setError((cause as Error).message); await reload(); }
    finally { setBusy(false); }
  }
  return <form className="mcp-rule-row" onSubmit={event => { event.preventDefault(); void save(); }}>
    <strong>{entry.service.name} · {entry.service.enabled ? '已启用' : '已停用'}</strong>
    <fieldset disabled={busy || !entry.editable}>
      {draft.kind === 'project' && <><label><input type="checkbox" checked={draft.excluded} onChange={event => change({ ...draft, excluded: event.target.checked })} />在本项目排除</label><label>项目账号<select value={draft.accountId ?? ''} onChange={event => change({ ...draft, accountId: event.target.value || null })}><option value="">未选择</option>{entry.accounts.filter(account => account.state !== 'revoked').map(account => <option key={account.accountId} value={account.accountId}>{account.label} · {mcpStateLabel(account.state)}</option>)}</select></label></>}
      {draft.kind === 'agent' && <><label><input type="checkbox" checked={draft.preferred} onChange={event => change({ ...draft, preferred: event.target.checked })} />优先使用</label><span>效果上限</span>{MCP_EFFECTS.map(effect => <label key={effect}><input type="checkbox" checked={draft.effectCeiling.includes(effect)} onChange={event => change({ ...draft, effectCeiling: event.target.checked ? [...draft.effectCeiling, effect] : draft.effectCeiling.filter(value => value !== effect) })} />{MCP_EFFECT_LABELS[effect]}</label>)}</>}
      {draft.kind === 'session' && <label><input type="checkbox" checked={draft.disabled} onChange={event => change({ ...draft, disabled: event.target.checked })} />在本会话临时停用</label>}
    </fieldset>
    {entry.availability && <p className="section-hint">{entry.availability.available ? '当前规则允许；连接、分类和本次许可仍需分别核对。' : entry.availability.details.join('；')} 效果上限：{entry.availability.effectCeiling.map(effect => MCP_EFFECT_LABELS[effect]).join('、') || '无'}</p>}
    {entry.reason && <p className="section-hint">{entry.reason}</p>}
    {!entry.editable && <p className="section-hint">此归属当前只读，规则仍保留。</p>}
    {base !== (entry.rule?.revision ?? 0) && dirty && <p role="status">规则已在别处变化。输入已保留，请核对最新规则后重新编辑。</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="mcp-actions"><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => { setDraft(entry.rule?.target ?? empty); setBase(entry.rule?.revision ?? 0); setDirty(false); setError(''); }}>放弃草稿并采用最新规则</button><button className="primary-button" disabled={busy || !entry.editable || !dirty || base !== (entry.rule?.revision ?? 0)}>保存规则</button></div>
  </form>;
}
