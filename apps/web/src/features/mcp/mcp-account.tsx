import { useEffect, useState } from 'react';
import type { McpAccount, McpAccountStatus, McpService } from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { mcpApi, mcpCommand } from './mcp-api.js';

const PHASES: Record<string, string> = { ready: '就绪', pending: '等待登录', exchanging: '交换结果待核对', refreshing: '刷新结果待核对', expired: '已过期', revoked: '已撤销', unconfigured: '未配置', 'login-required': '需要登录', 'configuration-changed': '服务配置已变化，需要重新配置账号' };
export function McpAccountEditor({ account, service, onRefresh, onBusy, onDirty }: { account: McpAccount; service: McpService; onRefresh: () => Promise<void>; onBusy: (value: boolean) => void; onDirty: (value: boolean) => void }) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<McpAccountStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [bearer, setBearer] = useState(''), [environment, setEnvironment] = useState<Record<string, string>>({});
  const [config, setConfig] = useState({ issuer: '', authorizationEndpoint: '', tokenEndpoint: '', clientId: '', scope: '' });
  const [edited, setEdited] = useState(false), [base, setBase] = useState(account.revision), [loginUrl, setLoginUrl] = useState('');
  const privateDirty = Boolean(bearer || Object.values(environment).some(Boolean));
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { onDirty(edited || privateDirty); return () => onDirty(false); }, [edited, privateDirty, onDirty]);
  useEffect(() => { if (!edited && !privateDirty) setBase(account.revision); }, [account.revision, edited, privateDirty]);
  useEffect(() => { let current = true; void mcpApi<McpAccountStatus>(`/account-status?accountId=${account.accountId}`).then(value => { if (current) setStatus(value); }).catch(cause => { if (current) setError((cause as Error).message); }); return () => { current = false; }; }, [account]);
  async function run(action: () => Promise<unknown>, preserveDraft = false) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); if (!preserveDraft) setEdited(false); }
    catch (cause) { setError((cause as Error).message); }
    finally { if (!preserveDraft) { setBearer(''); setEnvironment({}); } await onRefresh(); try { setStatus(await mcpApi(`/account-status?accountId=${account.accountId}`)); } catch {} setBusy(false); }
  }
  const identity = () => ({ commandId: mcpCommand(), accountId: account.accountId, revision: base });
  return <section className="detail-section mcp-account" aria-label={`账号 ${account.label}`}>
    <h3>{account.label} · {PHASES[status?.phase ?? account.state] ?? status?.phase ?? account.state}</h3>
    <p className="section-hint">账号版本 {account.revision}。凭据保存在本实例的私有存储中，保存后不回显。</p>
    {status?.expiresAt && <p>令牌到期：{new Date(status.expiresAt).toLocaleString()}</p>}
    {base !== account.revision && (edited || privateDirty) && <p role="alert">账号已在别处变化。输入已保留；请放弃草稿后重新核对。</p>}
    {error && <p role="alert" className="form-error">{error} 请先核对账号状态。秘密提交后不回显。</p>}
    {account.auth === 'bearer' && <form onSubmit={event => { event.preventDefault(); void run(() => mcpApi('/account-configure', { ...identity(), bearer: service.transport.kind === 'stdio' ? null : bearer, environment })); }}>
      <fieldset disabled={busy || base !== account.revision}>
        {service.transport.kind !== 'stdio' ? <label>Bearer 令牌<input type="password" autoComplete="new-password" value={bearer} maxLength={16000} onChange={event => setBearer(event.target.value)} required /></label> : service.transport.environmentKeys.map(key => <label key={key}>{key}<input type="password" autoComplete="new-password" value={environment[key] ?? ''} maxLength={16000} onChange={event => setEnvironment({ ...environment, [key]: event.target.value })} /></label>)}
        <button className="primary-button" disabled={!privateDirty}>保存私有凭据</button>
      </fieldset>
    </form>}
    {account.auth === 'oauth' && <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await mcpApi<{ loginUrl: string }>('/oauth-start', { ...identity(), config }); setLoginUrl(result.loginUrl); }); }}>
      <p className="section-hint">使用已登记的公共客户端。核对提供方的 HTTPS 端点后生成链接，再自行打开登录页。回调地址由本实例固定。</p>
      <fieldset disabled={busy || base !== account.revision}>
        {(['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'clientId', 'scope'] as const).map(key => <label key={key}>{{ issuer: '提供方 issuer', authorizationEndpoint: '授权端点', tokenEndpoint: '令牌端点', clientId: '公共 client_id', scope: 'scope' }[key]}<input type={key.includes('Endpoint') || key === 'issuer' ? 'url' : 'text'} value={config[key]} maxLength={key === 'clientId' ? 256 : 4096} required={key !== 'scope'} onChange={event => { setConfig({ ...config, [key]: event.target.value }); setEdited(true); setLoginUrl(''); }} /></label>)}
        <button className="primary-button" disabled={status?.phase === 'pending' || status?.phase === 'exchanging' || status?.phase === 'refreshing'}>生成登录链接</button>
      </fieldset>
      {loginUrl && status?.phase === 'pending' && <p><a href={loginUrl} target="_blank" rel="noreferrer noopener">打开提供方登录页</a></p>}
    </form>}
    <div className="mcp-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(async () => { await mcpApi(`/account-status?accountId=${account.accountId}`); }, true)}>核对账号状态</button>
      {account.auth !== 'none' && <button type="button" className="secondary-button" disabled={busy || account.state === 'revoked'} onClick={() => void run(() => mcpApi('/account-reconcile', { accountId: account.accountId }), true)}>核对保存或登录结果</button>}
      {account.auth === 'oauth' && <>
        <button type="button" className="secondary-button" disabled={busy || !['ready', 'expired'].includes(status?.phase ?? '')} onClick={() => void run(() => mcpApi('/oauth-refresh', identity()))}>刷新令牌</button>
        <button type="button" className="secondary-button" disabled={busy || account.state !== 'login-required'} onClick={() => void run(() => mcpApi('/oauth-cancel', identity()))}>取消此次登录</button>
      </>}
      <button type="button" className="secondary-button" disabled={busy || account.state === 'revoked'} onClick={() => void confirm({ title: `撤销账号「${account.label}」`, description: '使旧分类、许可和连接失效，并删除本机凭据。提供方的远程登录需在提供方自行撤销。', tone: 'danger', confirmLabel: '撤销本机账号', action: () => run(() => mcpApi('/account-revoke', identity())) })}>撤销账号</button>
      {(edited || privateDirty) && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setBearer(''); setEnvironment({}); setEdited(false); setBase(account.revision); setError(''); }}>放弃账号草稿</button>}
    </div>
  </section>;
}
