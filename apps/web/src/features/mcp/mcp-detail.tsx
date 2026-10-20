import { useEffect, useRef, useState } from 'react';
import { GLOBAL_ASSISTANT_SESSION_ID, type McpAccount, type McpCall, type McpConnectionPreview, type McpConnectionResult, type McpEffect, type McpManagementDetail, type WorkspaceSession } from '@multivac/contracts';
import { useConfirm, ConfirmCard } from '../../components/confirm-card.js';
import { listWorkspaceSessions } from '../../data/workspace-api.js';
import { McpAccountEditor } from './mcp-account.js';
import { McpScope } from './mcp-scope.js';
import './mcp-session-tools.css';
import { MCP_EFFECTS, MCP_EFFECT_LABELS, MCP_LOCAL_PROCESS_NOTICE, mcpRunsAsUser, McpRequestError, mcpApi, mcpCommand, mcpStateLabel } from './mcp-api.js';

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
  return <section className="session-detail project-detail mcp-detail" aria-label={`MCP 服务 ${service.name}`}>
    <div className="project-detail-head"><h2>{service.name}</h2><p>{service.removed ? '已移除 · 仅保留历史' : service.enabled ? '已启用' : '已停用'} · 管理版本 {service.revision}</p></div>
    {error && <p role="alert" className="form-error">{error} 已保留输入；请核对最新状态。</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="detail-section"><h3>来源与配置</h3><p className="section-hint">{service.source}</p><pre className="mcp-json">{JSON.stringify(service.transport, null, 2)}</pre><p className="section-hint">配置版本：{service.configVersion}。登记、启用、连接、分类和执行许可分别记录。</p>
      {service.transport.kind === 'legacy-sse' && <p role="status">旧 HTTP+SSE 仅保留登记资料，不能连接。</p>}
      <div className="mcp-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={onEdit}>编辑配置</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(() => mcpApi('/state', { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, action: service.enabled ? 'disable' : 'enable' }))}>{service.enabled ? '停用并关闭连接' : '启用服务'}</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => void confirm({ title: `移除「${service.name}」`, description: '停止后续使用并关闭现有连接。保留历史事实、调用与引用；不会撤销提供方的账号。', tone: 'danger', confirmLabel: '移除服务', action: () => run(() => mcpApi('/state', { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, action: 'remove' })) })}>移除服务</button></div>
    </section>
    <section className="detail-section"><h3>账号</h3>
      <label>选择账号<select disabled={disabled} value={accountId} onChange={event => void chooseAccount(event.target.value)}><option value="">请选择</option>{detail.accounts.map(value => <option key={value.accountId} value={value.accountId}>{value.label} · {mcpStateLabel(value.state)}</option>)}</select></label>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { const intent = createIntent.current ??= { commandId: mcpCommand(), serviceId: service.serviceId, revision: service.revision, label, auth }; const created = await mcpApi<McpAccount>('/account-create', intent); setAccountId(created.accountId); setLabel(''); createIntent.current = null; }); }}><fieldset disabled={disabled}><label>新账号名称<input value={label} maxLength={128} required onChange={event => { setLabel(event.target.value); createIntent.current = null; }} /></label><label>认证方式<select value={auth} onChange={event => { setAuth(event.target.value as McpAccount['auth']); createIntent.current = null; }}><option value="none">无需认证</option><option value="bearer">{service.transport.kind === 'stdio' ? '私有环境变量' : '静态 Bearer'}</option>{service.transport.kind === 'streamable-http' && <option value="oauth">OAuth 公共客户端</option>}</select></label><button className="secondary-button" disabled={!label.trim()}>添加账号</button></fieldset></form>
    </section>
    {account && !service.removed && <McpAccountEditor key={account.accountId} account={account} service={service} onRefresh={refresh} onBusy={setAccountBusy} onDirty={setAccountDirty} />}
    <section className="detail-section"><h3>连接与目录</h3>
      <label>实际执行会话<select value={sessionId} disabled={disabled || Boolean(unknownConnect)} onChange={event => { setSessionId(event.target.value); setProof(null); }}><option value={GLOBAL_ASSISTANT_SESSION_ID}>Multivac · 仅获准读取</option>{sessions.filter(value => value.sessionId !== GLOBAL_ASSISTANT_SESSION_ID).map(value => <option key={value.sessionId} value={value.sessionId}>{value.title}</option>)}</select></label>
      <p className="section-hint">连接会在所选会话的实际目录和宿主边界内启动服务或访问地址。连接不执行工具，也不读取资源内容。</p>
      <button type="button" className="secondary-button" disabled={disabled || !account || !service.enabled || Boolean(unknownConnect)} onClick={() => void run(async () => setProof(await mcpApi('/connect-preview', { serviceId: service.serviceId, accountId, sessionId })))}>预览连接范围</button>
      {unknownConnect && <div role="status"><p>原连接响应未知。先核对原命令，不能重复启动。</p><button type="button" className="secondary-button" disabled={disabled} onClick={() => void run(async () => { const result = await mcpApi<McpConnectionResult>(`/connect-result?commandId=${unknownConnect}`); setNotice(result.connection ? `原连接当前状态：${mcpStateLabel(result.connection.state)}` : '尚无可证明的连接结果，请保留原命令并继续核对。'); if (result.connection && ['connected', 'closed', 'failed'].includes(result.connection.state)) setUnknownConnect(null); })}>核对原连接</button></div>}
      <ul className="mcp-records" aria-label="最近连接">{detail.connections.map(({ connection, usable }) => <li key={connection.connectionId}><strong>{mcpStateLabel(connection.state)}{usable ? ' · 当前目录可用' : ' · 当前不可用'}</strong><span>会话 {connection.sessionId} · 账号版本 {connection.accountRevision}{connection.errorCode ? ` · ${connection.errorCode}` : ''}</span>{connection.state === 'closed' && connection.errorCode === 'result-unknown' && <p>本地连接已结束，远程会话是否关闭仍未知。</p>}{!usable && !connection.localStopConfirmedAt && connection.state !== 'closed' && <p>停止尚无证据；旧进程缺少本地所有权时，保留原范围占用。</p>}<div className="mcp-actions"><button type="button" className="inline-link" disabled={disabled || connection.state !== 'connected'} onClick={() => void run(() => mcpApi('/refresh', { commandId: mcpCommand(), connectionId: connection.connectionId }))}>重新发现目录</button><button type="button" className="inline-link" disabled={Boolean(stopId) || connection.state === 'closed'} onClick={() => void stop(connection.connectionId)}>关闭此连接</button>{onOpenSession && <button type="button" className="inline-link" onClick={() => onOpenSession(connection.sessionId)}>打开所属会话</button>}</div></li>)}</ul>
    </section>
    <section className="detail-section"><h3>真实目录与可信分类</h3><p className="section-hint">服务声明只是资料。用户确认分类后，实际调用仍需逐次许可。配置、账号或目录变化会使旧分类失效。</p>
      {!detail.catalogs.length && <p>连接并完成目录发现后显示工具和资源。</p>}
      {detail.catalogs.map(({ catalog, current }) => {
        const connection = detail.connections.find(value => value.usable && value.connection.accountId === catalog.accountId && value.connection.sessionId === sessionId)?.connection;
        return <div key={catalog.catalogId}><p>账号 {detail.accounts.find(value => value.accountId === catalog.accountId)?.label} · {current ? '配置及账号版本匹配' : '旧目录，需重新连接'} · {catalog.discoveredAt}</p>
          {catalog.tools.map(tool => <McpToolRow key={`${catalog.catalogId}:${tool.toolId}`} detail={detail} catalogId={catalog.catalogId} toolId={tool.toolId} connectionId={current ? connection?.connectionId : undefined} sessionId={sessionId} disabled={disabled} run={run} />)}
          <details><summary>资源目录（{catalog.resources.length}）及模板（{catalog.resourceTemplates.length}）</summary>{[...catalog.resources.map(value => ({ ...value, uri: value.uri })), ...catalog.resourceTemplates.map(value => ({ ...value, uri: value.uriTemplate }))].map((value, index) => <p key={index}><strong>{value.name}</strong> · <code>{value.uri}</code> · {value.description}</p>)}</details>
        </div>;
      })}
    </section>
    {!service.removed ? <McpScope kind="session" id={sessionId} /> : <details><summary>移除前的作用域规则</summary><pre className="mcp-json">{JSON.stringify(detail.rules, null, 2)}</pre></details>}
    <section className="detail-section"><h3>最近调用</h3><p className="section-hint">成功、失败、取消请求和结果未知分别显示。结果未知时不自动重发。</p><ul className="mcp-records">{detail.calls.map(value => <li key={value.callId}><span>{mcpStateLabel(value.state)} · {value.identity.sessionId} · {value.errorCode ?? '无错误码'}</span><button type="button" className="inline-link" disabled={working} onClick={() => void run(async () => setCall(await mcpApi(`/call?callId=${value.callId}`)))}>查看此调用结果</button></li>)}</ul>{call && <div><p>调用 {call.callId} · {mcpStateLabel(call.state)}</p><pre className="mcp-json">{call.resultText ?? '没有已核对的结果正文。'}</pre><button type="button" className="inline-link" onClick={() => setCall(null)}>关闭结果</button></div>}</section>
    {proof && <ConfirmCard title="确认连接 MCP 服务" confirmLabel="按此范围连接" confirmDisabled={!proof.available} busy={busy} onCancel={() => setProof(null)} onConfirm={() => void connect()} details={[`来源：${proof.source}`, `账号：${proof.accountLabel}（版本 ${proof.accountRevision}）`, `会话：${proof.sessionId}`, `宿主：${proof.host}；项目：${proof.projectId ?? '日常'}`, `实际目录：${proof.workingDirectory}`]}>{mcpRunsAsUser(proof) && <p className="mcp-run-notice" role="note">{MCP_LOCAL_PROCESS_NOTICE}</p>}<pre className="mcp-json">{JSON.stringify(proof.transport, null, 2)}</pre>{proof.reasons.map(reason => <p key={reason} role="status">{reason}</p>)}</ConfirmCard>}
  </section>;
}
export function McpToolRow({ detail, catalogId, toolId, connectionId, sessionId, disabled, run }: { detail: McpManagementDetail; catalogId: string; toolId: string; connectionId: string | undefined; sessionId: string; disabled: boolean; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const catalog = detail.catalogs.find(value => value.catalog.catalogId === catalogId)!.catalog, tool = catalog.tools.find(value => value.toolId === toolId)!;
  const [effects, setEffects] = useState<McpEffect[]>([]);
  const applicable = detail.classifications.filter(value => detail.accounts.some(account => account.accountId === catalog.accountId && account.revision === catalog.accountRevision) && value.toolId === toolId && value.accountId === catalog.accountId && value.accountRevision === catalog.accountRevision && value.configVersion === detail.service.configVersion && value.catalogVersion === catalog.version && value.definitionVersion === tool.definitionVersion && !value.revokedAt);
  return <details className="mcp-tool"><summary>{tool.name} · {applicable.length ? '已确认分类' : '待确认分类'}</summary><p>{tool.description}</p><h4>服务声明（不授予可信等级）</h4><pre className="mcp-json">{JSON.stringify(tool.annotations, null, 2)}</pre><details><summary>输入与输出 Schema</summary><pre className="mcp-json">{JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }, null, 2)}</pre></details><p>工具身份：{tool.toolId}；定义版本：{tool.definitionVersion}</p>
    <h4>已确认分类</h4>{applicable.map(value => <p key={value.classificationId}>{value.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、')} · {value.confirmedAt} <button type="button" className="inline-link" disabled={disabled} onClick={() => void run(() => mcpApi('/classification-revoke', { commandId: mcpCommand(), serviceId: detail.service.serviceId, classificationId: value.classificationId, revision: value.revision }))}>撤销此分类</button></p>)}
    <details><summary>历史分类及撤销记录</summary>{detail.classifications.filter(value => value.toolId === toolId && value.accountId === catalog.accountId && !applicable.some(current => current.classificationId === value.classificationId)).map(value => <p key={value.classificationId}>{value.effects.map(effect => MCP_EFFECT_LABELS[effect]).join('、')} · {value.revokedAt ? '已撤销' : '版本已变化，不适用'} · {value.confirmedAt}</p>)}</details>
    <fieldset disabled={disabled || !connectionId}><legend>根据实际工具行为确认效果</legend>{MCP_EFFECTS.map(effect => <label key={effect}><input type="checkbox" checked={effects.includes(effect)} onChange={event => setEffects(event.target.checked ? [...effects, effect] : effects.filter(value => value !== effect))} />{MCP_EFFECT_LABELS[effect]}</label>)}<button type="button" className="secondary-button" disabled={!effects.length} onClick={() => void run(async () => { await mcpApi('/classify', { commandId: mcpCommand(), sessionId, connectionId, toolId, catalogVersion: catalog.version, definitionVersion: tool.definitionVersion, effects }); setEffects([]); })}>确认这些效果</button></fieldset>{!connectionId && <p className="section-hint">所选会话需要先建立有效连接，再核对当前目录。</p>}
  </details>;
}
