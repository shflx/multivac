import { useEffect, useRef, useState } from 'react';
import { Check } from 'typebox/value';
import { McpResourceReadSchema, assistantQuoteWithinLimit, type AssistantMcpQuote, type McpResourceRead, type McpResourceReadPreview, type McpResourceReadResult, type McpResourceReference } from '@multivac/contracts';
import { ConfirmCard } from '../../components/confirm-card.js';
import { mcpApi as mcpRequest, mcpCommand } from './mcp-api.js';

interface ResourceItem { kind: 'resource' | 'template'; connectionId: string; catalogVersion: string; serviceName: string; accountId: string; accountRevision: number; resource: { name: string; uri?: string; uriTemplate?: string; mimeType: string | null } }
interface ResourcePage { items: ResourceItem[]; total: number; nextOffset: number | null }
const storageKey = (id: string) => `multivac.mcp.resource-read.${id}`;
function restored(id: string): McpResourceRead | null { try { const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? 'null'); return Check(McpResourceReadSchema, value) && value.sessionId === id ? value : null; } catch { return null; } }
function remember(id: string, input: McpResourceRead | null) { try { if (input) sessionStorage.setItem(storageKey(id), JSON.stringify(input)); else sessionStorage.removeItem(storageKey(id)); } catch { /* 当前窗口仍保留命令；不因存储失败自动重发。 */ } }
export function resourceQuote(sessionId: string, result: McpResourceReadResult, text: string): AssistantMcpQuote | null {
  const snapshot = result.snapshot, source = snapshot?.provenance;
  if (!snapshot || !source || snapshot.sessionId !== sessionId || !text.trim() || !snapshot.text.includes(text)) return null;
  const reference: McpResourceReference = { snapshotId: snapshot.snapshotId, serviceId: snapshot.serviceId, serviceName: source.serviceName, accountId: snapshot.accountId, accountLabel: source.accountLabel,
    accountRevision: snapshot.accountRevision, configVersion: snapshot.configVersion, catalogVersion: snapshot.catalogVersion, uri: snapshot.uri, mimeType: snapshot.mimeType, readAt: snapshot.readAt, truncated: snapshot.truncated };
  const quote: AssistantMcpQuote = { sourceKind: 'mcp', sourceMcp: reference, sourceSessionId: sessionId, sourceTitle: source.serviceName, text };
  return assistantQuoteWithinLimit(quote) ? quote : null;
}
/**
 * 命令恢复只查询原读取结果；正文进入现有引用草稿后由原发送回执负责恢复和重试。
 * 由输入区“+”菜单打开，打开时读取本会话可引用的资源目录。
 */
export function McpResourcePicker({ sessionId, onQuote, open, onClose }: { sessionId: string; onQuote: (quote: AssistantMcpQuote) => void; open: boolean; onClose: () => void }) {
  const [page, setPage] = useState<ResourcePage | null>(null), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ResourceItem | null>(null), [parameters, setParameters] = useState('{}');
  const [preview, setPreview] = useState<McpResourceReadPreview | null>(null), [intent, setIntent] = useState<McpResourceRead | null>(() => restored(sessionId));
  const [result, setResult] = useState<McpResourceReadResult | null>(null), [excerpt, setExcerpt] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setIntent(restored(sessionId)); setPage(null); setSelected(null); setPreview(null); setResult(null); setExcerpt(''); setError(''); }, [sessionId]);
  async function run(work: () => Promise<void>) { const current = generation.current; setBusy(true); setError(''); try { await work(); } catch (error) { if (generation.current === current) setError(error instanceof Error ? error.message : '资源请求未完成，请核对原命令。'); } finally { if (generation.current === current) setBusy(false); } }
  async function load(value: number) { const current = generation.current; const next = await mcpRequest<ResourcePage>(`/resources?sessionId=${encodeURIComponent(sessionId)}&offset=${value}&limit=25`); if (current !== generation.current) return; setPage(next); setOffset(value); }
  function apply(next: McpResourceReadResult) { setResult(next); if (next.snapshot) setExcerpt(new TextEncoder().encode(next.snapshot.text).length <= 4096 ? next.snapshot.text : ''); }
  async function prepare() {
    if (!selected) return;
    let values: unknown; try { values = JSON.parse(parameters); } catch { throw Error('模板参数需要 JSON 对象。'); }
    const current = generation.current;
    const next = await mcpRequest<McpResourceReadPreview>('/resource-preview', { sessionId, connectionId: selected.connectionId, catalogVersion: selected.catalogVersion,
      ...(selected.kind === 'resource' ? { uri: selected.resource.uri } : { template: selected.resource.uriTemplate }), parameters: selected.kind === 'resource' ? {} : values });
    if (current === generation.current) setPreview(next);
  }
  async function read() {
    if (!preview || intent) return;
    const input: McpResourceRead = { ...preview.selection, commandId: mcpCommand(), fingerprint: preview.fingerprint }, current = generation.current;
    setIntent(input); remember(sessionId, input);
    const next = await mcpRequest<McpResourceReadResult>('/resource-read', input);
    if (current === generation.current) apply(next);
  }
  async function reconcile() { if (!intent) return; const current = generation.current; const next = await mcpRequest<McpResourceReadResult>('/resource-result', intent); if (current === generation.current) apply(next); }
  const quote = result ? resourceQuote(sessionId, result, excerpt) : null;
  const close = () => { generation.current++; setBusy(false); onClose(); };
  useEffect(() => { if (open) void run(() => load(0)); }, [open]);
  return <>
    {open && <ConfirmCard title="引用 MCP 资源" description="只显示本会话已连接且规则允许的资源；可在能力管理连接服务。选择、读取、加入草稿和发送分别处理。"
      confirmLabel={result?.snapshot ? '加入引用草稿' : intent ? '核对原读取结果' : preview ? '确认读取' : '预览读取范围'}
      confirmDisabled={busy || (result?.snapshot ? !quote : !intent && !preview && !selected)} busy={busy} error={error} onCancel={close}
      onConfirm={() => { if (quote) { onQuote(quote); remember(sessionId, null); setIntent(null); close(); } else void run(() => intent ? reconcile() : preview ? read() : prepare()); }}>
      {intent ? <>
        <p>原读取命令：{intent.commandId}。响应未知时仅核对，不自动重新读取。</p>
        {result && <p>结果：{result.status === 'succeeded' ? '已读取固定快照' : result.status === 'not-started' ? '尚无读取意图；可放弃后重新选择' : '未知；请查看连接与服务记录'}</p>}
        {result?.snapshot && <><p>{result.snapshot.provenance?.serviceName} · {result.snapshot.uri} · {result.snapshot.mimeType} · 读取于 {result.snapshot.readAt}{result.snapshot.truncated ? ' · 内容已截断至 32 KB' : ''}。此为历史快照，不表示最新内容。</p><label>资源文本：选择最多 4 KiB 内容作为引用<textarea readOnly rows={10} value={result.snapshot.text} onSelect={event => { const input = event.currentTarget; setExcerpt(input.value.slice(input.selectionStart, input.selectionEnd)); }} /></label><p>引用选区</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', overflowWrap: 'anywhere' }}>{excerpt || '请在上方文本中选择内容'}</pre><p>加入草稿会替换当前引用；发送时将此选区交给所选模型，仍需通过当前外传规则。</p></>}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { remember(sessionId, null); setIntent(null); setResult(null); setPreview(null); setSelected(null); setExcerpt(''); }}>放弃本次引用并重新选择</button>
      </> : preview ? <><p>{preview.impact}</p><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 300, overflow: 'auto', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.evidence, null, 2)}</pre><button type="button" disabled={busy} onClick={() => setPreview(null)}>返回选择</button></> : <>
        <p className="section-hint">共 {page?.total ?? 0} 项。目录来自已发现元数据，浏览列表不会读取资源正文。</p>
        {page && !page.items.length && <p className="mcp-resource-empty">本会话还没有可引用的资源。可在输入框底栏的“MCP”中连接服务。</p>}
        <div className="mcp-resource-options" role="radiogroup" aria-label="选择资源">
          {page?.items.map((item, index) => <label key={`${item.connectionId}:${item.kind}:${index}`} className={selected === item ? 'selected' : ''}>
            <input type="radio" name={`mcp-resource-${sessionId}`} checked={selected === item} onChange={() => { setSelected(item); setParameters('{}'); }} />
            <span><strong>{item.resource.name}</strong><small>{item.serviceName} · {item.kind === 'template' ? '模板' : '资源'} · <code>{item.resource.uri ?? item.resource.uriTemplate}</code></small></span>
          </label>)}
        </div>
        {page && (offset > 0 || page.nextOffset != null) && <div className="mcp-resource-pages"><button type="button" className="secondary-button compact" disabled={busy || offset === 0} onClick={() => void run(() => load(Math.max(0, offset - 25)))}>上一页</button><button type="button" className="secondary-button compact" disabled={busy || page.nextOffset == null} onClick={() => void run(() => load(page.nextOffset!))}>下一页</button></div>}
        {selected?.kind === 'template' && <label className="mcp-resource-params">模板参数（JSON，仅支持 {'{name}'}）<textarea value={parameters} onChange={event => setParameters(event.target.value)} /></label>}
      </>}
    </ConfirmCard>}
  </>;
}
