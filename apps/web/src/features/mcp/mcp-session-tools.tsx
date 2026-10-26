import { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, LoaderCircle, Link2, Plug, Settings2, Wrench } from 'lucide-react';
import type { McpAccount, McpConnection, McpConnectionPreview, McpConnectionResult, McpManagementDetail, McpRule, McpScopeEntry } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { usePageOpener } from '../assistant/object-links.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { MCP_EFFECT_LABELS, MCP_LOCAL_PROCESS_NOTICE, McpRequestError, applicableClassifications, mcpApi, mcpCommand, mcpRunsAsUser } from './mcp-api.js';
import './mcp-session-tools.css';

type ServiceStatus = 'ready' | 'disconnected' | 'paused' | 'blocked';
/** 服务端规则在会话尚未连接账号时给出的说明。 */
const ACCOUNT_MISSING = '未选择可用的服务账号';

interface SessionService {
  entry: McpScopeEntry;
  status: ServiceStatus;
  reason: string;
  /** 连接时使用的账号：规则选定的账号，否则唯一可用的账号；无法确定时为空，需到管理页选择。 */
  accountId: string | null;
  /** 未连接时缺少什么：可直接连接、可自动建默认账号后连接，或须到管理页配置 / 选择账号。 */
  setup: 'ready' | 'default-account' | 'configure' | 'choose' | null;
  tools: { toolId: string; name: string; description: string; effects: string | null }[];
}

/** 汇总一个服务在本会话中的状态：会话停用 → 服务未启用 → 规则不允许 → 未连接 → 可用。 */
function sessionService(entry: McpScopeEntry, detail: McpManagementDetail | null, sessionId: string): SessionService {
  const ready = entry.accounts.filter(account => account.state === 'ready');
  const accountId = entry.availability?.accountId ?? (ready.length === 1 ? ready[0]!.accountId : null);
  const base = { entry, accountId, setup: null as SessionService['setup'], tools: [] as SessionService['tools'] };
  if (entry.rule?.target.kind === 'session' && entry.rule.target.disabled) return { ...base, status: 'paused', reason: '已在本会话停用' };
  if (!entry.service.enabled) return { ...base, status: 'blocked', reason: '服务未启用' };
  // 没有项目账号选择时，会话账号来自本会话的连接；尚未连接导致的“未选择账号”按未连接处理，其他原因才算规则不允许。
  const availability = entry.availability;
  if (availability && availability.reasons.some(reason => reason !== 'credential-unavailable')) {
    // 未连接时“未选择账号”总会出现，真正拦住它的是其他原因，优先展示。
    const details = [...availability.details.filter(detail => detail !== ACCOUNT_MISSING), ...availability.details.filter(detail => detail === ACCOUNT_MISSING)];
    return { ...base, status: 'blocked', reason: details.join('；') };
  }
  const connection: McpConnection | undefined = detail?.connections.find(value => value.usable && value.connection.sessionId === sessionId)?.connection;
  if (!connection) {
    // 不需要私有凭据的本地服务可以由系统建一个“无需认证”的默认账号，免去手动添加。
    const transport = entry.service.transport;
    const setup = accountId ? 'ready' : ready.length ? 'choose' : transport.kind === 'stdio' && !transport.environmentKeys.length && !entry.accounts.length ? 'default-account' : 'configure';
    const reason = { ready: '未连接到本会话', 'default-account': '未连接；将创建无需认证的默认账号', choose: '有多个账号，请在管理页选择后连接', configure: '需要先在管理页配置账号' }[setup];
    return { ...base, status: 'disconnected', setup, reason };
  }
  const catalog = detail?.catalogs.find(value => value.current && value.catalog.accountId === connection.accountId)?.catalog;
  const tools = (catalog?.tools ?? []).map(tool => {
    const classification = applicableClassifications(detail!, catalog!, tool)[0];
    return { toolId: tool.toolId, name: tool.name, description: tool.description, effects: classification ? classification.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、') : null };
  });
  return { ...base, status: 'ready', reason: tools.length ? '' : '已连接，尚未发现工具', tools };
}

/**
 * 输入区的 MCP 状态：只表达“本会话能用哪些工具”，不指定本条消息使用哪个工具。
 * 是否调用由模型决定，每次调用仍在 Inbox 单独许可；连接沿用预览确认流程。
 */
export function McpSessionTools({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const openPage = usePageOpener();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [services, setServices] = useState<SessionService[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [proof, setProof] = useState<McpConnectionPreview | null>(null);
  const [openService, setOpenService] = useState<string | null>(null), [showUnavailable, setShowUnavailable] = useState(false);
  const menu = useRef<HTMLDivElement>(null), generation = useRef(0), accountCommands = useRef(new Map<string, string>());
  const menuId = useId();

  async function load() {
    const read = ++generation.current;
    setLoading(true);
    try {
      const entries = (await mcpApi<McpScopeEntry[]>(`/scope?kind=session&id=${encodeURIComponent(sessionId)}`)).filter(entry => !entry.service.removed);
      const details = await Promise.all(entries.map(entry => mcpApi<McpManagementDetail>(`/detail?serviceId=${encodeURIComponent(entry.service.serviceId)}`).catch(() => null)));
      if (read !== generation.current) return;
      setServices(entries.map((entry, index) => sessionService(entry, details[index] ?? null, sessionId)));
      setError('');
    } catch (cause) {
      if (read === generation.current) setError((cause as Error).message);
    } finally {
      if (read === generation.current) setLoading(false);
    }
  }
  useEffect(() => { setServices([]); void load(); return () => { generation.current++; }; }, [sessionId]);
  useOptionalWorkbenchEvents(event => { if (['mcp.changed', 'workbench.connected'].includes(event.type)) void load(); });
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.parentElement?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  async function act(serviceId: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(serviceId); setError('');
    try { await work(); } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(null); await load(); }
  }
  /** 会话开关对应“在本会话临时停用”规则；修订号冲突时报错并重新读取，不覆盖别处的修改。 */
  const toggle = (service: SessionService) => act(service.entry.service.serviceId, async () => {
    await mcpApi<McpRule>('/rule', { commandId: mcpCommand(), serviceId: service.entry.service.serviceId, revision: service.entry.rule?.revision ?? 0,
      target: { kind: 'session', sessionId, disabled: service.status !== 'paused' } });
  });
  /** 需要时先建默认账号（同一服务重试沿用原命令，不重复创建），再预览连接范围。 */
  const preview = (service: SessionService) => act(service.entry.service.serviceId, async () => {
    let accountId = service.accountId;
    if (!accountId && service.setup === 'default-account') {
      const serviceId = service.entry.service.serviceId;
      const commandId = accountCommands.current.get(serviceId) ?? mcpCommand();
      accountCommands.current.set(serviceId, commandId);
      accountId = (await mcpApi<McpAccount>('/account-create', { commandId, serviceId, revision: service.entry.service.revision, label: '默认账号', auth: 'none' })).accountId;
      accountCommands.current.delete(serviceId);
    }
    if (!accountId) return;
    setProof(await mcpApi<McpConnectionPreview>('/connect-preview', { serviceId: service.entry.service.serviceId, accountId, sessionId }));
  });
  async function connect() {
    if (!proof) return;
    const input = { commandId: mcpCommand(), serviceId: proof.serviceId, accountId: proof.accountId, sessionId: proof.sessionId, fingerprint: proof.fingerprint };
    setProof(null);
    await act(input.serviceId, async () => {
      try { await mcpApi<McpConnectionResult>('/connect', input); }
      catch (cause) {
        // 结果未知时不在此重试，交给管理页按原命令核对。
        if (cause instanceof McpRequestError && cause.unknown) throw Error('连接结果未知，请到“管理 · 能力”核对原连接，不要重复连接。');
        throw cause;
      }
    });
  }

  /** 每行一个操作：未连接给“连接”，可用或本会话停用给开关，不可用不给操作；完整原因放在提示中。 */
  const renderService = (service: SessionService) => {
    // 只展示本会话能用的工具；未分类的不会被调用，只在一个都不能用时提示去分类。
    const usableTools = service.tools.filter(tool => tool.effects);
    const id = service.entry.service.serviceId, working = busy === id, expanded = openService === id && usableTools.length > 0;
    const needsClassification = service.status === 'ready' && !usableTools.length && service.tools.length > 0;
    const label = service.status === 'ready' ? (usableTools.length ? `${usableTools.length} 个可用` : needsClassification ? '需分类' : '未发现工具')
      : service.status === 'disconnected' ? (service.setup === 'configure' ? '需配置账号' : service.setup === 'choose' ? '需选择账号' : '未连接') : service.status === 'paused' ? '本会话已停用' : service.reason.split('；')[0]; // 多个原因只显示第一个，完整内容在悬停提示中
    const canToggle = service.entry.editable && !needsClassification && (service.status === 'ready' || service.status === 'paused');
    return <section key={id} className={`mcp-session-service ${service.status} ${expanded ? 'expanded' : ''}`} aria-label={service.entry.service.name}>
      <header title={service.reason || undefined}>
        <span className={`mcp-session-dot ${service.status}`} aria-hidden="true" />
        {usableTools.length > 0
          ? <button type="button" className="mcp-session-name" aria-expanded={expanded} onClick={() => setOpenService(expanded ? null : id)}>
              <strong>{service.entry.service.name}</strong><small>{label}</small>
              <ChevronRight className="mcp-session-chevron" aria-hidden="true" />
            </button>
          : <span className="mcp-session-name"><strong>{service.entry.service.name}</strong><small className={needsClassification ? 'pending' : undefined} title={needsClassification ? `已发现 ${service.tools.length} 个工具，确认效果分类后才会被调用` : undefined}>{label}</small></span>}
        {service.status === 'disconnected' && (service.setup === 'ready' || service.setup === 'default-account') && <button type="button" className="mcp-session-connect" disabled={Boolean(busy)} onClick={() => void preview(service)}>
          {working ? <LoaderCircle className="spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}连接
        </button>}
        {(service.status === 'disconnected' && (service.setup === 'configure' || service.setup === 'choose') || needsClassification) && openPage && <button type="button" className="mcp-session-connect" onClick={() => { setOpen(false); openPage('skills'); }}>
          <Settings2 aria-hidden="true" />{needsClassification ? '去分类' : '去配置'}
        </button>}
        {canToggle && <button type="button" role="switch" className="preference-switch" aria-checked={service.status !== 'paused'}
          aria-label={`在本会话${service.status === 'paused' ? '启用' : '停用'} ${service.entry.service.name}`} disabled={Boolean(busy)} onClick={() => void toggle(service)}><span aria-hidden="true" /></button>}
      </header>
      {expanded && <ul>{usableTools.map(tool => <li key={tool.toolId} title={tool.description}>
        <Wrench aria-hidden="true" /><code>{tool.name}</code><span className="ready">{tool.effects}</span>
      </li>)}</ul>}
    </section>;
  };
  // 可用在前、需处理的其次；不可用的单独成组并弱化，避免与可操作项混在一起。
  const order: Record<ServiceStatus, number> = { ready: 0, disconnected: 1, paused: 2, blocked: 3 };
  const sorted = [...services].sort((left, right) => order[left.status] - order[right.status]);
  const usable = sorted.filter(service => service.status !== 'blocked'), unavailable = sorted.filter(service => service.status === 'blocked');

  const readyTools = services.filter(service => service.status === 'ready').reduce((sum, service) => sum + service.tools.filter(tool => tool.effects).length, 0);
  // 只在需要用户处理时提醒：有服务未连接，或已连接但一个可用工具都没有。
  const attention = services.some(service => service.status === 'disconnected' || (service.status === 'ready' && service.tools.length > 0 && !service.tools.some(tool => tool.effects)));
  if (!services.length && !loading && !error) return null;

  return <div className="mcp-session-tools">
    <button type="button" className="mcp-session-trigger" aria-expanded={open} aria-controls={menuId} disabled={disabled}
      title="本会话可用的 MCP 工具；是否调用由模型决定，每次调用单独许可" onClick={() => { setOpen(value => !value); if (!open) void load(); }}>
      <Plug aria-hidden="true" /><span><span className="mcp-session-label">MCP{readyTools ? ' · ' : ''}</span>{readyTools || ''}</span>{attention && <i className="mcp-session-attention" role="img" aria-label="有服务待处理" />}
    </button>
    {open && <div ref={menu} className="mcp-session-menu" id={menuId} role="dialog" aria-label="本会话的 MCP 工具"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
      <div className="mcp-session-heading"><strong>MCP 工具</strong>{services.length > 0 && <span>{services.filter(service => service.status === 'ready').length} / {services.length} 可用</span>}</div>
      {error && <p className="mcp-session-error" role="alert"><CircleAlert aria-hidden="true" />{error}</p>}
      <div className="mcp-session-list">
        {loading && !services.length && <p className="mcp-session-empty"><LoaderCircle className="spin" aria-hidden="true" />正在读取…</p>}
        {usable.map(renderService)}
        {/* 不可用的服务默认折叠为一行，需要时再展开查看原因。 */}
        {unavailable.length > 0 && <button type="button" className="mcp-session-group" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(value => !value)}>
          不可用 · {unavailable.length}<ChevronRight aria-hidden="true" />
        </button>}
        {showUnavailable && unavailable.map(renderService)}
      </div>
      <div className="mcp-session-footer">
        <span title="模型按需调用 MCP 工具，每次调用需在 Inbox 单独许可">每次调用需许可</span>
        {openPage && <button type="button" onClick={() => { setOpen(false); openPage('skills'); }}><Settings2 aria-hidden="true" />管理 MCP</button>}
      </div>
    </div>}
    {proof && <ConfirmCard title="连接到本会话" confirmLabel="按此范围连接" confirmDisabled={!proof.available} busy={Boolean(busy)} onCancel={() => setProof(null)} onConfirm={() => void connect()}
      details={[`来源：${proof.source}`, `账号：${proof.accountLabel}（版本 ${proof.accountRevision}）`, `宿主：${proof.host}；项目：${proof.projectId ?? '日常'}`, `实际目录：${proof.workingDirectory}`]}>
      {mcpRunsAsUser(proof) && <p className="mcp-run-notice" role="note">{MCP_LOCAL_PROCESS_NOTICE}</p>}
      <p className="section-hint">连接不执行工具，也不读取资源内容；工具分类与每次调用许可仍需分别决定。</p>
      {proof.reasons.map(reason => <p key={reason} role="status">{reason}</p>)}
    </ConfirmCard>}
  </div>;
}
