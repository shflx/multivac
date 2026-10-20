import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, Globe, Info, KeyRound, Link2, Pencil, Plus, Power, SquareTerminal, Trash2, Wrench } from 'lucide-react';
import { GLOBAL_ASSISTANT_SESSION_ID, type McpAccount, type McpCall, type McpConnectionPreview, type McpConnectionResult, type McpEffect, type McpManagementDetail, type WorkspaceSession } from '@multivac/contracts';
import { useConfirm, ConfirmCard } from '../../components/confirm-card.js';
import { listWorkspaceSessions } from '../../data/workspace-api.js';
import { McpAccountEditor } from './mcp-account.js';
import { McpScope } from './mcp-scope.js';
import { MCP_EFFECTS, MCP_EFFECT_LABELS, MCP_LOCAL_PROCESS_NOTICE, McpRequestError, applicableClassifications, mcpApi, mcpRunsAsUser, mcpCommand, mcpStateLabel, mcpTransportLabel } from './mcp-api.js';
import { McpTransportFacts } from './mcp-transport.js';
import './mcp-session-tools.css';

export function McpDetail({ detail, refresh, onEdit, onBusy, onDirty, onOpenSession }: { detail: McpManagementDetail; refresh: () => Promise<void>; onEdit: () => void; onBusy: (value: boolean) => void; onDirty: (value: boolean) => void; onOpenSession?: (id: string) => void }) {
  const confirm = useConfirm(), service = detail.service;
  const [busy, setBusy] = useState(false), [accountBusy, setAccountBusy] = useState(false), [accountDirty, setAccountDirty] = useState(false), [error, setError] = useState('');
  const [accountId, setAccountId] = useState(''), [label, setLabel] = useState(''), [auth, setAuth] = useState<McpAccount['auth']>('none');
  const [sessionId, setSessionId] = useState<string>(GLOBAL_ASSISTANT_SESSION_ID), [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [proof, setProof] = useState<McpConnectionPreview | null>(null), [unknownConnect, setUnknownConnect] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [call, setCall] = useState<McpCall | null>(null), [stopId, setStopId] = useState<string | null>(null);
  const createIntent = useRef<{ commandId: string; serviceId: string; revision: number; label: string; auth: McpAccount['auth'] } | null>(null);
  const account = detail.accounts.find(value => value.accountId === accountId);
  useEffect(() => { onBusy(busy || accountBusy || Boolean(stopId)); return () => onBusy(false); }, [busy, accountBusy, stopId, onBusy]);
  useEffect(() => { onDirty(accountDirty || Boolean(label)); return () => onDirty(false); }, [accountDirty, label, onDirty]);
  useEffect(() => { void listWorkspaceSessions({ allWorkspaces: true }).then(value => setSessions(value.sessions.filter(item => !item.archivedAt && !item.host))).catch(cause => setError((cause as Error).message)); }, []);
  async function run(action: () => Promise<unknown>) {
    if (busy || accountBusy || stopId) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError((cause as Error).message); }
    finally { await refresh(); setBusy(false); }
  }
  async function stop(connectionId: string) {
    if (stopId) return;
    setStopId(connectionId); setError('');
    try { await mcpApi('/disconnect', { commandId: mcpCommand(), connectionId }); }
    catch (cause) { setError((cause as Error).message); }
    finally { await refresh(); setStopId(null); }
  }
  async function chooseAccount(value: string) {
    if (accountDirty && !await confirm({ title: '放弃账号草稿', description: '切换账号会清除当前私有输入。', tone: 'danger', confirmLabel: '放弃并切换' })) return;
    setAccountId(value); setProof(null); setNotice('');
  }
  async function connect() {
    if (!proof) return;
    const input = { commandId: mcpCommand(), serviceId: service.serviceId, accountId: proof.accountId, sessionId: proof.sessionId, fingerprint: proof.fingerprint };
    setProof(null);
    await run(async () => {
      try { const result = await mcpApi<McpConnectionResult>('/connect', input); setNotice(`已核对连接：${result.connection ? mcpStateLabel(result.connection.state) : '结果待核对'}。工具分类和每次调用许可需分别决定。`); }
      catch (cause) { if (cause instanceof McpRequestError && cause.unknown) setUnknownConnect(input.commandId); throw cause; }
    });
  }
  const working = busy || accountBusy || Boolean(stopId), disabled = working || service.removed;
  const sessionTitle = (id: string) => id === GLOBAL_ASSISTANT_SESSION_ID ? 'Multivac 对话' : sessions.find(value => value.sessionId === id)?.title ?? '工作会话';
  const authLabel = (value: McpAccount['auth']) => value === 'none' ? '无需认证' : value === 'oauth' ? 'OAuth' : service.transport.kind === 'stdio' ? '私有环境变量' : 'Bearer 令牌';
  const TransportIcon = service.transport.kind === 'stdio' ? SquareTerminal : Globe;
  const status = service.removed ? { label: '已移除', tone: 'muted' } : service.enabled ? { label: '已启用', tone: 'success' } : { label: '已停用', tone: 'muted' };
  return <section className="session-detail project-detail mcp-detail-pane mcp-detail" aria-label={`MCP 服务 ${service.name}`}>
    <div className="project-detail-head mcp-head">
      <div className="project-title">
        <span className="mcp-heading-icon"><TransportIcon aria-hidden="true" /></span>
        <h2>{service.name}</h2>
        <span className={`mcp-tag ${status.tone}`}>{status.label}</span>
        {!service.removed && <div className="mcp-head-actions">
          <button type="button" className="secondary-button compact" disabled={disabled} onClick={onEdit}><Pencil aria-hidden="true" />编辑配置</button>
          <button type="button" className={`${service.enabled ? 'secondary-button' : 'primary-button'} compact`} disabled={disabled} onClick={() => void run(() => mcpApi('/state', { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, action: service.enabled ? 'disable' : 'enable' }))}><Power aria-hidden="true" />{service.enabled ? '停用并关闭连接' : '启用服务'}</button>
          <button type="button" className="secondary-button compact danger" disabled={disabled} onClick={() => void confirm({ title: `移除「${service.name}」`, description: '停止后续使用并关闭现有连接。保留历史事实、调用与引用；不会撤销提供方的账号。', tone: 'danger', confirmLabel: '移除服务', action: () => run(() => mcpApi('/state', { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, action: 'remove' })) })}><Trash2 aria-hidden="true" />移除</button>
        </div>}
      </div>
      <p className="mcp-meta"><span>{mcpTransportLabel(service.transport.kind)}</span><span>管理版本 {service.revision}</span><span title={service.configVersion}>配置版本 {service.configVersion.slice(0, 12)}</span>{service.removed && <span>仅保留历史</span>}</p>
    </div>
    {error && <p role="alert" className="mcp-alert"><CircleAlert aria-hidden="true" /><span>{error} 已保留输入；请核对最新状态。</span></p>}
    {notice && <p role="status" className="mcp-notice"><Info aria-hidden="true" /><span>{notice}</span></p>}

    <McpSection title="配置" hint="登记、启用、连接、分类和执行许可分别记录。">
      <McpTransportFacts transport={service.transport} source={service.source} />
      {service.transport.kind === 'legacy-sse' && <p role="status" className="section-hint">旧 HTTP+SSE 仅保留登记资料，不能连接。</p>}
    </McpSection>

    <McpSection title="账号" hint="凭据保存在本实例的私有存储中，保存后不回显。">
      <div className="mcp-rows">
        {detail.accounts.map(value => <button type="button" key={value.accountId} className={`mcp-row mcp-account-row ${value.accountId === accountId ? 'selected' : ''}`} aria-pressed={value.accountId === accountId} disabled={disabled} onClick={() => void chooseAccount(value.accountId === accountId ? '' : value.accountId)}>
          <KeyRound aria-hidden="true" /><span>{value.label}</span><small>{authLabel(value.auth)}</small><span className={`mcp-tag ${value.state === 'ready' ? 'success' : value.state === 'revoked' ? 'muted' : 'warn'}`}>{mcpStateLabel(value.state)}</span>
        </button>)}
        <form className="mcp-row mcp-add-row" onSubmit={event => { event.preventDefault(); void run(async () => { const intent = createIntent.current ??= { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, label, auth }; const created = await mcpApi<McpAccount>('/account-create', intent); setAccountId(created.accountId); setLabel(''); createIntent.current = null; }); }}>
          <fieldset disabled={disabled}>
            <Plus aria-hidden="true" />
            <input aria-label="新账号名称" placeholder="新账号名称，如“个人账号”" value={label} maxLength={128} required onChange={event => { setLabel(event.target.value); createIntent.current = null; }} />
            <select aria-label="认证方式" value={auth} onChange={event => { setAuth(event.target.value as McpAccount['auth']); createIntent.current = null; }}><option value="none">无需认证</option><option value="bearer">{service.transport.kind === 'stdio' ? '私有环境变量' : '静态 Bearer'}</option>{service.transport.kind === 'streamable-http' && <option value="oauth">OAuth 公共客户端</option>}</select>
            <button className="secondary-button compact" disabled={!label.trim()}>添加账号</button>
          </fieldset>
        </form>
      </div>
      {account && !service.removed && <McpAccountEditor key={account.accountId} account={account} service={service} onRefresh={refresh} onBusy={setAccountBusy} onDirty={setAccountDirty} />}
    </McpSection>

    <McpSection title="连接" hint="连接会在所选会话的实际目录和宿主边界内启动服务或访问地址；连接不执行工具，也不读取资源内容。">
      <div className="mcp-card mcp-connect">
        <label className="mcp-field"><span>实际执行会话</span><select value={sessionId} disabled={disabled || Boolean(unknownConnect)} onChange={event => { setSessionId(event.target.value); setProof(null); }}><option value={GLOBAL_ASSISTANT_SESSION_ID}>Multivac · 仅获准读取</option>{sessions.filter(value => value.sessionId !== GLOBAL_ASSISTANT_SESSION_ID).map(value => <option key={value.sessionId} value={value.sessionId}>{value.title}</option>)}</select></label>
        <button type="button" className="primary-button" disabled={disabled || !account || !service.enabled || Boolean(unknownConnect)} onClick={() => void run(async () => setProof(await mcpApi('/connect-preview', { serviceId: service.serviceId, accountId, sessionId })))}><Link2 aria-hidden="true" />预览连接范围</button>
        {(!service.enabled || !account) && !service.removed && <p className="section-hint">{!service.enabled ? '先启用服务' : '先在上方选择账号'}，再预览连接。</p>}
      </div>
      {unknownConnect && <div role="status" className="mcp-card mcp-warning"><p>原连接响应未知。先核对原命令，不能重复启动。</p><button type="button" className="secondary-button compact" disabled={disabled} onClick={() => void run(async () => { const result = await mcpApi<McpConnectionResult>(`/connect-result?commandId=${unknownConnect}`); setNotice(result.connection ? `原连接当前状态：${mcpStateLabel(result.connection.state)}` : '尚无可证明的连接结果，请保留原命令并继续核对。'); if (result.connection && ['connected', 'closed', 'failed'].includes(result.connection.state)) setUnknownConnect(null); })}>核对原连接</button></div>}
      {detail.connections.length > 0 && <ul className="mcp-rows mcp-records" aria-label="最近连接">{detail.connections.map(({ connection, usable }) => <li key={connection.connectionId} className="mcp-row mcp-record">
        <span className={`mcp-status-dot ${connection.state === 'connected' ? 'on' : 'off'}`} aria-hidden="true" />
        <span className="mcp-record-copy"><strong>{mcpStateLabel(connection.state)}{usable ? ' · 当前目录可用' : ' · 当前不可用'}</strong><small>{sessionTitle(connection.sessionId)} · 账号版本 {connection.accountRevision}{connection.errorCode ? ` · ${connection.errorCode}` : ''}</small>
          {connection.state === 'closed' && connection.errorCode === 'result-unknown' && <small className="warn">本地连接已结束，远程会话是否关闭仍未知。</small>}
          {!usable && !connection.localStopConfirmedAt && connection.state !== 'closed' && <small className="warn">停止尚无证据；旧进程缺少本地所有权时，保留原范围占用。</small>}
        </span>
        <span className="mcp-record-actions"><button type="button" className="inline-link" disabled={disabled || connection.state !== 'connected'} onClick={() => void run(() => mcpApi('/refresh', { commandId: mcpCommand(), connectionId: connection.connectionId }))}>重新发现目录</button><button type="button" className="inline-link" disabled={Boolean(stopId) || connection.state === 'closed'} onClick={() => void stop(connection.connectionId)}>关闭连接</button>{onOpenSession && <button type="button" className="inline-link" onClick={() => onOpenSession(connection.sessionId)}>打开会话</button>}</span>
      </li>)}</ul>}
    </McpSection>

    <McpSection title="工具与资源" hint="工作会话中，工具首次被调用时会在 Inbox 许可里一并确认效果，这里的分类可预先确认或撤销。每次调用仍需许可；配置、账号或目录变化会使旧分类失效。">
      {!detail.catalogs.length && <p className="mcp-empty-note">连接并完成目录发现后，这里显示工具和资源。</p>}
      {detail.catalogs.map(({ catalog, current }) => {
        const connection = detail.connections.find(value => value.usable && value.connection.accountId === catalog.accountId && value.connection.sessionId === sessionId)?.connection;
        return <div key={catalog.catalogId} className="mcp-catalog">
          <p className="mcp-meta"><span>账号 {detail.accounts.find(value => value.accountId === catalog.accountId)?.label}</span><span className={current ? undefined : 'warn'}>{current ? '与当前配置及账号匹配' : '旧目录，需重新连接'}</span><span>{new Date(catalog.discoveredAt).toLocaleString('zh-CN', { hour12: false })}</span></p>
          <div className="mcp-tools">{catalog.tools.map(tool => <McpToolRow key={`${catalog.catalogId}:${tool.toolId}`} detail={detail} catalogId={catalog.catalogId} toolId={tool.toolId} connectionId={current ? connection?.connectionId : undefined} sessionId={sessionId} disabled={disabled} run={run} />)}</div>
          <details className="mcp-fold"><summary>资源 {catalog.resources.length} · 模板 {catalog.resourceTemplates.length}</summary><ul className="mcp-resources">{[...catalog.resources.map(value => ({ ...value, uri: value.uri })), ...catalog.resourceTemplates.map(value => ({ ...value, uri: value.uriTemplate }))].map((value, index) => <li key={index}><strong>{value.name}</strong><code>{value.uri}</code>{value.description && <small>{value.description}</small>}</li>)}</ul></details>
        </div>;
      })}
    </McpSection>

    {!service.removed ? <McpScope kind="session" id={sessionId} title={`会话规则 · ${sessionTitle(sessionId)}`} /> : <details className="mcp-fold"><summary>移除前的作用域规则</summary><pre className="mcp-json">{JSON.stringify(detail.rules, null, 2)}</pre></details>}

    <McpSection title="最近调用" hint="成功、失败、取消请求和结果未知分别显示；结果未知时不自动重发。">
      {detail.calls.length ? <ul className="mcp-rows mcp-records">{detail.calls.map(value => <li key={value.callId} className="mcp-row mcp-record">
        <span className={`mcp-tag ${value.state === 'succeeded' ? 'success' : ['failed', 'unknown'].includes(value.state) ? 'warn' : 'muted'}`}>{mcpStateLabel(value.state)}</span>
        <span className="mcp-record-copy"><small>{sessionTitle(value.identity.sessionId)}{value.errorCode ? ` · ${value.errorCode}` : ''}</small></span>
        <span className="mcp-record-actions"><button type="button" className="inline-link" disabled={working} onClick={() => void run(async () => setCall(await mcpApi(`/call?callId=${value.callId}`)))}>查看结果</button></span>
      </li>)}</ul> : <p className="mcp-empty-note">还没有调用记录。</p>}
      {call && <div className="mcp-card"><p className="mcp-meta"><span>调用 {call.callId.slice(0, 8)}</span><span>{mcpStateLabel(call.state)}</span></p><pre className="mcp-json">{call.resultText ?? '没有已核对的结果正文。'}</pre><button type="button" className="inline-link" onClick={() => setCall(null)}>关闭结果</button></div>}
    </McpSection>
    {proof && <ConfirmCard title="确认连接 MCP 服务" confirmLabel="按此范围连接" confirmDisabled={!proof.available} busy={busy} onCancel={() => setProof(null)} onConfirm={() => void connect()} details={[`来源：${proof.source}`, `账号：${proof.accountLabel}（版本 ${proof.accountRevision}）`, `会话：${sessionTitle(proof.sessionId)}`, `宿主：${proof.host}；项目：${proof.projectId ?? '日常'}`, `实际目录：${proof.workingDirectory}`]}>{mcpRunsAsUser(proof) && <p className="mcp-run-notice" role="note">{MCP_LOCAL_PROCESS_NOTICE}</p>}<pre className="mcp-json">{JSON.stringify(proof.transport, null, 2)}</pre>{proof.reasons.map(reason => <p key={reason} role="status">{reason}</p>)}</ConfirmCard>}
  </section>;
}

/** 详情分区：标题与一句说明，样式与 Skill 详情一致。 */
function McpSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return <section className="detail-section mcp-section" aria-labelledby={id}>
    <div className="section-title"><h3 id={id}>{title}</h3></div>
    {hint && <p className="section-hint">{hint}</p>}
    {children}
  </section>;
}

export function McpToolRow({ detail, catalogId, toolId, connectionId, sessionId, disabled, run }: { detail: McpManagementDetail; catalogId: string; toolId: string; connectionId: string | undefined; sessionId: string; disabled: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const catalog = detail.catalogs.find(value => value.catalog.catalogId === catalogId)!.catalog, tool = catalog.tools.find(value => value.toolId === toolId)!;
  const [effects, setEffects] = useState<McpEffect[]>([]);
  const applicable = applicableClassifications(detail, catalog, tool);
  return <details className="mcp-tool">
    <summary>
      <Wrench aria-hidden="true" />
      <span className="mcp-tool-copy"><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</span>
      <span className={`mcp-tag ${applicable.length ? 'success' : 'muted'}`} title={applicable.length ? undefined : '工作会话中首次调用时，在 Inbox 许可里一并确认效果；也可在此预先确认'}>{applicable.length ? applicable[0]!.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、') : '首次调用时确认'}</span>
      <ChevronRight className="mcp-tool-chevron" aria-hidden="true" />
    </summary>
    <div className="mcp-tool-body">
      <fieldset className="mcp-effects" disabled={disabled || !connectionId}><legend>预先确认效果（可选）</legend>
        <div className="mcp-effect-options">{MCP_EFFECTS.map(effect => <label key={effect} className={effects.includes(effect) ? 'checked' : ''}><input type="checkbox" checked={effects.includes(effect)} onChange={event => setEffects(event.target.checked ? [...effects, effect] : effects.filter(value => value !== effect))} />{MCP_EFFECT_LABELS[effect]}</label>)}</div>
        <button type="button" className="secondary-button compact" disabled={!effects.length} onClick={() => void run(async () => { await mcpApi('/classify', { commandId: mcpCommand(), sessionId, connectionId, toolId, catalogVersion: catalog.version, definitionVersion: tool.definitionVersion, effects }); setEffects([]); })}>确认这些效果</button>
      </fieldset>
      {!connectionId && <p className="section-hint">所选会话需要先建立有效连接，再核对当前目录。</p>}
      {applicable.length > 0 && <div className="mcp-classifications"><h4>已确认分类</h4>{applicable.map(value => <p key={value.classificationId}>{value.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、')} · {new Date(value.confirmedAt).toLocaleString('zh-CN', { hour12: false })} <button type="button" className="inline-link" disabled={disabled} onClick={() => void run(() => mcpApi('/classification-revoke', { commandId: mcpCommand(), serviceId: detail.service.serviceId, classificationId: value.classificationId, revision: value.revision }))}>撤销</button></p>)}</div>}
      <details className="mcp-fold"><summary>服务声明与 Schema</summary><p className="section-hint">服务声明不授予可信等级。工具身份 {tool.toolId}；定义版本 {tool.definitionVersion.slice(0, 12)}</p><pre className="mcp-json">{JSON.stringify({ annotations: tool.annotations, input: tool.inputSchema, output: tool.outputSchema }, null, 2)}</pre></details>
      <details className="mcp-fold"><summary>历史分类及撤销记录</summary>{detail.classifications.filter(value => value.toolId === toolId && value.accountId === catalog.accountId && !applicable.some(current => current.classificationId === value.classificationId)).map(value => <p key={value.classificationId} className="section-hint">{value.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、')} · {value.revokedAt ? '已撤销' : '版本已变化，不适用'} · {value.confirmedAt}</p>)}</details>
    </div>
  </details>;
}
