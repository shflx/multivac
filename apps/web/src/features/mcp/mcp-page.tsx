import { useEffect, useRef, useState } from 'react';
import type { McpImportPreview, McpManagementDetail, McpService } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { McpDetail } from './mcp-detail.js';
import { listMcpServices, mcpApi, mcpCommand } from './mcp-api.js';
import './mcp.css';

export interface McpPageProps { active: boolean; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void; discardSignal: number; onOpenSession?: (id: string) => void }
export function McpPage({ active, onDirtyChange, onBusyChange, discardSignal, onOpenSession }: McpPageProps) {
  const confirm = useConfirm();
  const [services, setServices] = useState<McpService[]>([]), [selected, setSelected] = useState(''), [detail, setDetail] = useState<McpManagementDetail | null>(null);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [detailBusy, setDetailBusy] = useState(false), [detailDirty, setDetailDirty] = useState(false), [error, setError] = useState('');
  const [importing, setImporting] = useState(false), [config, setConfig] = useState(''), [source, setSource] = useState('用户粘贴');
  const [target, setTarget] = useState<{ serviceId: string; revision: number } | null>(null), [previews, setPreviews] = useState<McpImportPreview[]>([]);
  const generation = useRef(0), previewCommand = useRef(mcpCommand());
  const dirty = Boolean(config || previews.length || detailDirty);
  const disabled = busy || detailBusy;
  function reset() { setConfig(''); setPreviews([]); setSource('用户粘贴'); setTarget(null); setImporting(false); previewCommand.current = mcpCommand(); }
  useEffect(() => { reset(); setSelected(''); setDetail(null); }, [discardSignal]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(disabled); return () => onBusyChange(false); }, [disabled, onBusyChange]);
  async function load() {
    const read = ++generation.current;
    try {
      const list = await listMcpServices();
      if (read !== generation.current) return;
      setServices(list); setLoaded(true);
      if (selected && !list.some(value => value.serviceId === selected)) { setSelected(''); setDetail(null); }
      else if (selected) { const value = await mcpApi<McpManagementDetail>(`/detail?serviceId=${selected}`); if (read === generation.current) setDetail(value); }
    } catch (cause) { if (read === generation.current) { setError((cause as Error).message); setLoaded(true); } }
  }
  useEffect(() => { if (active) void load(); return () => { generation.current++; }; }, [active, selected]);
  useWorkbenchEvents(event => { if (active && ['mcp.changed', 'workbench.connected'].includes(event.type)) void load(); });
  async function run(action: () => Promise<unknown>) {
    if (disabled) return;
    setBusy(true); setError('');
    try { await action(); } catch (cause) { setError((cause as Error).message); }
    finally { await load(); setBusy(false); }
  }
  async function leave() {
    if (disabled) return false;
    return !dirty || await confirm({ title: '放弃未保存的能力草稿', description: '清除当前配置及私有输入。已确认的服务登记仍保留。', tone: 'danger', confirmLabel: '放弃草稿' });
  }
  function changeConfig(value: string) { setConfig(value); setPreviews([]); previewCommand.current = mcpCommand(); }
  async function startImport() { if (await leave()) { reset(); setSelected(''); setDetail(null); setImporting(true); } }
  async function select(serviceId: string) { if (serviceId === selected && !importing) return; if (!await leave()) return; reset(); setDetail(null); setSelected(serviceId); if (serviceId === selected) await load(); }
  return <section className="projects-page mcp-page" data-management-page="skills" aria-label="MCP 服务与工具管理">
    {active && <ManagementPageActions><button type="button" className="secondary-button" disabled={disabled} onClick={() => void startImport()}>添加或导入 MCP</button><button type="button" className="secondary-button" disabled={disabled} onClick={() => void load()}>核对最新状态</button></ManagementPageActions>}
    {error && <p role="alert" className="form-error">{error} <button type="button" className="inline-link" disabled={disabled} onClick={() => void load()}>只读核对</button></p>}
    {!loaded && <p role="status">正在读取 MCP 服务…</p>}
    <div className="sessions-layout projects-layout mcp-layout"><div className="project-list-pane"><div className="session-list project-list" aria-label="已登记 MCP 服务">{services.map(service => <button type="button" key={service.serviceId} className={service.serviceId === selected ? 'selected' : ''} disabled={disabled} aria-current={service.serviceId === selected ? 'true' : undefined} onClick={() => void select(service.serviceId)}><span className="session-list-copy"><strong>{service.name}</strong><small>{service.transport.kind} · {service.removed ? '已移除 · 历史' : service.enabled ? '已启用' : '已停用'}</small></span></button>)}</div>{loaded && !services.length && <p className="section-hint">尚无服务。可粘贴配置，或显式选择 JSON 文件后预览。</p>}</div>
      {importing ? <section className="session-detail project-detail mcp-import" aria-label={target ? '编辑 MCP 配置' : '导入 MCP 配置'}><h2>{target ? '编辑 MCP 配置' : '导入 MCP 配置'}</h2><p className="section-hint">仅解析当前输入并显示预览。确认登记后服务保持停用；连接、登录和调用需分别操作。请将 token、密码、私有 env 和请求头移到账号配置。</p>
        <form onSubmit={event => { event.preventDefault(); void run(async () => setPreviews(await mcpApi('/preview', { commandId: previewCommand.current, config, source, ...(target ?? {}) }))); }}><fieldset disabled={disabled}><label>来源说明<input value={source} maxLength={4096} required onChange={event => { setSource(event.target.value); setPreviews([]); previewCommand.current = mcpCommand(); }} /></label><label>公开配置 JSON<textarea value={config} maxLength={256000} rows={12} required spellCheck={false} autoFocus onChange={event => changeConfig(event.target.value)} placeholder={'{"mcpServers":{"示例":{"command":"/绝对路径/server","args":[]}}}'} /></label><label>选择 JSON 文件<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { if (file.size > 256000) throw Error('配置文件超过上限。'); changeConfig(await file.text()); setSource(`用户上传：${file.name}`); }); }} /></label><button className="primary-button" disabled={!config.trim()}>解析并预览</button><button type="button" className="secondary-button" onClick={() => void (async () => { if (await leave()) reset(); })()}>取消导入</button></fieldset></form>
        {target && services.find(value => value.serviceId === target.serviceId)?.revision !== target.revision && <div role="status"><p>服务版本已变化。草稿已保留，请先核对最新配置。</p><pre className="mcp-json">{JSON.stringify(services.find(value => value.serviceId === target.serviceId)?.transport ?? '服务已移除', null, 2)}</pre><button type="button" className="secondary-button" disabled={disabled} onClick={() => { const latest = services.find(value => value.serviceId === target.serviceId); setTarget(latest ? { serviceId: latest.serviceId, revision: latest.revision } : null); setPreviews([]); previewCommand.current = mcpCommand(); }}>{services.some(value => value.serviceId === target.serviceId) ? '采用已核对的最新版本，保留草稿' : '改为按新服务导入此草稿'}</button></div>}
        {previews.map(preview => <section className="mcp-preview" key={preview.previewId} aria-label={`导入预览 ${preview.name}`}><h3>{preview.name}</h3><p>来源：{preview.source}</p><pre className="mcp-json">{JSON.stringify(preview.transport, null, 2)}</pre><p>登记范围：本实例；服务初始停用。项目账号、排除规则、智能体上限和会话停用在对应入口单独确认。</p><p>预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}。{preview.existingServiceId && `本次修改绑定服务版本 ${preview.expectedServiceRevision}，不覆盖较新修改。`}</p><button type="button" className="primary-button" disabled={disabled} onClick={() => void run(async () => { const saved = await mcpApi<McpService>('/confirm', { commandId: `confirm-${preview.previewId}`, previewId: preview.previewId }); if (previews.length === 1) { reset(); setSelected(saved.serviceId); } else setPreviews(current => current.filter(value => value.previewId !== preview.previewId)); })}>确认登记此服务</button></section>)}
      </section> : detail ? <McpDetail key={detail.service.serviceId} detail={detail} refresh={load} onEdit={() => void (async () => { if (!await leave()) return; reset(); setImporting(true); setTarget({ serviceId: detail.service.serviceId, revision: detail.service.revision }); setConfig(JSON.stringify({ name: detail.service.name, transport: detail.service.transport }, null, 2)); setSource(detail.service.source); })()} onBusy={setDetailBusy} onDirty={setDetailDirty} {...(onOpenSession ? { onOpenSession } : {})} /> : <section className="session-detail project-detail"><h2>服务与工具</h2><p className="section-hint">选择服务查看来源、账号、连接及真实目录。已登记不代表已连接、已分类或已获得调用许可。</p></section>}
    </div>
  </section>;
}
