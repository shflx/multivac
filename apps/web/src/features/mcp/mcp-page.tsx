import { useEffect, useRef, useState } from 'react';
import { CircleAlert, FileJson, Globe, LoaderCircle, Pencil, Plug, Plus, RefreshCw, SquareTerminal } from 'lucide-react';
import type { McpImportPreview, McpManagementDetail, McpService } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { McpDetail } from './mcp-detail.js';
import { listMcpServices, mcpApi, mcpCommand, mcpTransportLabel } from './mcp-api.js';
import { McpTransportFacts } from './mcp-transport.js';
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
  const fileInput = useRef<HTMLInputElement>(null);
  // 未选择服务且不在导入时，默认展示第一个服务，右侧不留空白。
  useEffect(() => {
    if (active && loaded && !selected && !importing && services[0]) setSelected(services[0].serviceId);
  }, [active, loaded, selected, importing, services]);

  return <section className="projects-page mcp-page" data-management-page="skills" aria-label="MCP 服务与工具管理">
    {active && <ManagementPageActions>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => void load()}><RefreshCw aria-hidden="true" />核对最新状态</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => void startImport()}><Plus aria-hidden="true" />添加或导入 MCP</button>
    </ManagementPageActions>}
    {error && <p role="alert" className="mcp-alert"><CircleAlert aria-hidden="true" /><span>{error}</span><button type="button" className="inline-link" disabled={disabled} onClick={() => void load()}>只读核对</button></p>}
    {!loaded ? <div className="management-page-state" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" /><p role="status">正在读取 MCP 服务…</p></div> :
    <div className="sessions-layout projects-layout mcp-layout">
      <div className="project-list-pane">
        {services.length ? <div className="session-list project-list" role="list" aria-label="已登记 MCP 服务">{services.map(service => {
          const current = service.serviceId === selected && !importing;
          const TransportIcon = service.transport.kind === 'stdio' ? SquareTerminal : Globe;
          return <div key={service.serviceId} role="listitem"><button type="button" className={current ? 'selected' : ''} disabled={disabled} aria-current={current ? 'true' : undefined} onClick={() => void select(service.serviceId)}>
            <span className="mcp-list-icon"><TransportIcon aria-hidden="true" /></span>
            <span className="session-list-copy"><strong>{service.name}</strong><small>{mcpTransportLabel(service.transport.kind)}</small></span>
            <span className={`mcp-status-dot ${service.removed ? 'removed' : service.enabled ? 'on' : 'off'}`} title={service.removed ? '已移除' : service.enabled ? '已启用' : '已停用'} aria-label={service.removed ? '已移除' : service.enabled ? '已启用' : '已停用'} />
          </button></div>;
        })}</div> : <div className="mcp-list-empty"><Plug aria-hidden="true" /><p>尚无服务。可粘贴配置，或选择 JSON 文件后预览。</p></div>}
        <p className="settings-list-hint">登记不代表已连接或获准调用；连接、工具分类和每次调用分别确认。</p>
      </div>
      {importing ? <section className="session-detail project-detail mcp-detail-pane mcp-import" aria-label={target ? '编辑 MCP 配置' : '导入 MCP 配置'}>
        <div className="project-detail-head mcp-head">
          <div className="project-title"><span className="mcp-heading-icon">{target ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}</span><h2>{target ? '编辑 MCP 配置' : '导入 MCP 配置'}</h2></div>
          <p className="project-title-note">只解析当前输入并显示预览。确认登记后服务保持停用；连接、登录和调用需分别操作。token、密码、私有 env 和请求头请移到账号配置。</p>
        </div>
        <form className="mcp-card mcp-form" onSubmit={event => { event.preventDefault(); void run(async () => setPreviews(await mcpApi('/preview', { commandId: previewCommand.current, config, source, ...(target ?? {}) }))); }}><fieldset disabled={disabled}>
          <label className="mcp-field"><span>公开配置 JSON</span><textarea value={config} maxLength={256000} rows={12} required spellCheck={false} autoFocus onChange={event => changeConfig(event.target.value)} placeholder={'{"mcpServers":{"示例":{"command":"/绝对路径/server","args":[]}}}'} /></label>
          <div className="mcp-form-row">
            <label className="mcp-field"><span>来源说明</span><input value={source} maxLength={4096} required onChange={event => { setSource(event.target.value); setPreviews([]); previewCommand.current = mcpCommand(); }} /></label>
            <button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><FileJson aria-hidden="true" />从 JSON 文件读取</button>
            <input ref={fileInput} type="file" hidden accept=".json,application/json" aria-label="选择 JSON 文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(async () => { if (file.size > 256000) throw Error('配置文件超过上限。'); changeConfig(await file.text()); setSource(`用户上传：${file.name}`); }); }} />
          </div>
          <div className="project-constraints-actions"><button type="button" className="secondary-button" onClick={() => void (async () => { if (await leave()) reset(); })()}>取消导入</button><button className="primary-button" disabled={!config.trim()}>解析并预览</button></div>
        </fieldset></form>
        {target && services.find(value => value.serviceId === target.serviceId)?.revision !== target.revision && <div role="status" className="mcp-card mcp-warning"><p>服务版本已变化。草稿已保留，请先核对最新配置。</p><pre className="mcp-json">{JSON.stringify(services.find(value => value.serviceId === target.serviceId)?.transport ?? '服务已移除', null, 2)}</pre><button type="button" className="secondary-button" disabled={disabled} onClick={() => { const latest = services.find(value => value.serviceId === target.serviceId); setTarget(latest ? { serviceId: latest.serviceId, revision: latest.revision } : null); setPreviews([]); previewCommand.current = mcpCommand(); }}>{services.some(value => value.serviceId === target.serviceId) ? '采用已核对的最新版本，保留草稿' : '改为按新服务导入此草稿'}</button></div>}
        {previews.map(preview => <section className="mcp-card mcp-preview" key={preview.previewId} aria-label={`导入预览 ${preview.name}`}>
          <header><strong>{preview.name}</strong><span className="mcp-tag">{mcpTransportLabel(preview.transport.kind)}</span></header>
          <McpTransportFacts transport={preview.transport} source={preview.source} />
          <p className="section-hint">登记范围：本实例；服务初始停用。项目账号、排除规则、智能体上限和会话停用在对应入口单独确认。预览有效至 {new Date(preview.expiresAt).toLocaleTimeString()}。{preview.existingServiceId && `本次修改绑定服务版本 ${preview.expectedServiceRevision}，不覆盖较新修改。`}</p>
          <div className="project-constraints-actions"><button type="button" className="primary-button" disabled={disabled} onClick={() => void run(async () => { const saved = await mcpApi<McpService>('/confirm', { commandId: `confirm-${preview.previewId}`, previewId: preview.previewId }); if (previews.length === 1) { reset(); setSelected(saved.serviceId); } else setPreviews(current => current.filter(value => value.previewId !== preview.previewId)); })}>确认登记此服务</button></div>
        </section>)}
      </section> : detail ? <McpDetail key={detail.service.serviceId} detail={detail} refresh={load} onEdit={() => void (async () => { if (!await leave()) return; reset(); setImporting(true); setTarget({ serviceId: detail.service.serviceId, revision: detail.service.revision }); setConfig(JSON.stringify({ name: detail.service.name, transport: detail.service.transport }, null, 2)); setSource(detail.service.source); })()} onBusy={setDetailBusy} onDirty={setDetailDirty} {...(onOpenSession ? { onOpenSession } : {})} />
      : services.length ? <div className="management-page-state mcp-detail-state" aria-live="polite"><LoaderCircle className="spin" aria-hidden="true" /><p role="status">正在读取服务详情…</p></div>
      : <div className="management-page-state mcp-detail-state"><Plug aria-hidden="true" /><h2>接入第一个 MCP 服务</h2><p>粘贴 Claude Code、Cursor 等使用的 mcpServers 配置，预览后登记。</p><button type="button" className="primary-button" disabled={disabled} onClick={() => void startImport()}><Plus aria-hidden="true" />添加或导入 MCP</button></div>}
    </div>}
  </section>;
}
