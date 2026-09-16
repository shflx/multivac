import { Cable, Check, KeyRound, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ModelAccessSnapshot, ModelProfile } from '@multivac/contracts';
import {
  cancelModelCheck, configureModelApiKey, getModelAccessReceipt,
  MODEL_ACCESS_MESSAGES, ModelAccessApiError, revokeModelApiKey, startModelCheck,
} from '../../data/model-access-api.js';

const CHECK_LABELS = {
  checking: '正在检查', passed: '连接成功', failed: '连接失败', cancelled: '已取消',
  'timed-out': '检查超时', invalidated: '检查已失效', expired: '检查已过期',
};
export function ModelAccessPanel({ profile, profileRevision, active, locked, onRefresh, onBusy, onSnapshot, snapshot, refresh, accessIssue }: {
  profileRevision: number;
  profile: ModelProfile; active: boolean; locked: boolean;
  onSnapshot: (snapshot: ModelAccessSnapshot) => void;
  snapshot: ModelAccessSnapshot | null;
  refresh: () => Promise<void>;
  accessIssue: string | null;
  onRefresh: () => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmedTarget, setConfirmedTarget] = useState({ revision: profileRevision, provider: profile.provider });
  const reviewedCommand = useRef<string | null>(null);
  useEffect(() => {
    if (!active) setApiKey('');
  }, [active]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const observedCredential = snapshot?.credentials.find((entry) => entry.profileId === profile.profileId);
  const coherent = snapshot?.revision === profileRevision && observedCredential?.provider === profile.provider;
  const confirmed = confirmedTarget.revision === profileRevision && confirmedTarget.provider === profile.provider;
  const stale = !coherent || !confirmed;
  const credential = coherent ? observedCredential : undefined;
  const availability = coherent ? snapshot?.availability.find((entry) => entry.profileId === profile.profileId) : undefined;
  const check = coherent ? snapshot?.checks.find((entry) => entry.profileId === profile.profileId) : undefined;
  useLayoutEffect(() => {
    if (stale) { setApiKey(''); setNotice(null); }
  }, [stale, profileRevision, profile.provider]);
  useEffect(() => {
    const command = credential?.lastCommand;
    if (command && ['begun', 'unconfirmed'].includes(command.state) && reviewedCommand.current !== command.commandId) {
      setPendingId(command.commandId);
    }
  }, [credential]);
  const checking = check?.status === 'checking';
  const disabled = locked || busy || pendingId !== null || stale;

  async function mutate(action: 'configure' | 'revoke' | 'check') {
    if (!snapshot || disabled) return;
    const secret = action === 'configure' ? apiKey : '';
    setApiKey('');
    const command = { commandId: crypto.randomUUID(), profileId: profile.profileId,
      revision: profileRevision, accessRevision: snapshot.accessRevision };
    setBusy(true); setIssue(null); setNotice(null);
    if (action !== 'check') setPendingId(command.commandId);
    try {
      const result = action === 'configure' ? await configureModelApiKey({ ...command, apiKey: secret })
        : action === 'revoke' ? await revokeModelApiKey(command) : await startModelCheck(command);
      if (result.state === 'begun' || result.state === 'unconfirmed') setIssue(MODEL_ACCESS_MESSAGES.CREDENTIAL_RESULT_UNKNOWN);
      else {
        setPendingId(null);
        if (result.errorCode) setIssue(MODEL_ACCESS_MESSAGES[result.errorCode]);
        else if (action !== 'check') setNotice(result.replayed ? '原命令已消费，新的输入没有重复写入。'
          : action === 'configure' ? 'API Key 已由 Pi 保存。' : '已撤销 Pi 保存的 API Key。');
      }
      await refresh(); await onRefresh();
    } catch (error) {
      const code = error instanceof ModelAccessApiError ? error.code : 'ACCESS_UNAVAILABLE';
      setIssue(MODEL_ACCESS_MESSAGES[code]);
      if (code !== 'CREDENTIAL_RESULT_UNKNOWN') setPendingId(null);
      await refresh();
    } finally { setApiKey(''); setBusy(false); }
  }
  async function reconcile() {
    if (!pendingId || busy) return;
    setBusy(true);
    try {
      const result = await getModelAccessReceipt(pendingId);
      if (result.state !== 'begun') {
        reviewedCommand.current = pendingId;
        setPendingId(null);
        setIssue(result.errorCode ? MODEL_ACCESS_MESSAGES[result.errorCode] : null);
        setNotice(result.errorCode ? null : '原命令结果已确认。');
      }
      await refresh(); await onRefresh();
    } catch (error) {
      if (error instanceof ModelAccessApiError && error.code === 'NOT_FOUND') {
        reviewedCommand.current = pendingId;
        setPendingId(null);
        setIssue('原命令尚未接收，密钥没有自动重发；请刷新后重新输入。');
      } else setIssue(error instanceof ModelAccessApiError ? error.message : MODEL_ACCESS_MESSAGES.ACCESS_UNAVAILABLE);
    }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!check) return;
    try { const next = await cancelModelCheck(check.checkId); onSnapshot(next); }
    catch (error) { setIssue(error instanceof ModelAccessApiError ? error.message : MODEL_ACCESS_MESSAGES.ACCESS_UNAVAILABLE); }
  }
  return <section className="model-access-panel" aria-label="认证与连接">
    <h3><KeyRound aria-hidden="true" /> API Key</h3>
    <p>{!credential ? '凭据状态待刷新' : credential.storedApiKey ? 'Pi 已保存 API Key' : '无已保存 API Key'} · Provider：{profile.provider}</p>
    {credential && !credential.configurable && <p role="status">{MODEL_ACCESS_MESSAGES.CREDENTIAL_UNSUPPORTED}</p>}
    {snapshot && stale && <div className="model-access-target-warning" role="alert">
      <p>模型配置已变化；输入已清空，请刷新并确认当前 Provider。</p>
      <button type="button" disabled={busy || locked} onClick={() => { void refresh(); void onRefresh(); }}>
        <RefreshCw aria-hidden="true" />刷新当前配置</button>
      <button type="button" disabled={!coherent || busy || locked} onClick={() => {
        setApiKey(''); setConfirmedTarget({ revision: profileRevision, provider: profile.provider });
      }}><Check aria-hidden="true" />确认当前配置</button>
    </div>}
    <form onSubmit={(event) => { event.preventDefault(); void mutate('configure'); }} className="model-key-form">
      <label><span>一次性 API Key</span><input type="password" aria-label="一次性 API Key" autoComplete="off"
        value={stale ? '' : apiKey} disabled={disabled || !credential?.configurable} onChange={(event) => setApiKey(event.target.value)} /></label>
      <button type="submit" disabled={disabled || !credential?.configurable || !apiKey.trim()}><KeyRound aria-hidden="true" />配置 API Key</button>
      <button type="button" disabled={disabled || !credential?.storedApiKey} onClick={() => {
        if (window.confirm(`撤销 Provider ${profile.provider} 在 Pi 中保存的 API Key？`)) void mutate('revoke');
      }}><Trash2 aria-hidden="true" />撤销 API Key</button>
    </form>
    {issue && <p role="alert" className="model-access-issue">{issue}</p>}
    {accessIssue && <p role="alert" className="model-access-issue">{accessIssue}</p>}
    {notice && <p role="status">{notice}</p>}
    {pendingId && <button type="button" disabled={busy} onClick={() => void reconcile()}><RefreshCw aria-hidden="true" />查询原命令结果</button>}
    <div className="model-check-toolbar">
      <h3><Cable aria-hidden="true" />连接检查</h3>
      <button type="button" disabled={disabled || checking || !availability?.authenticated}
        onClick={() => void mutate('check')}><Cable aria-hidden="true" />检查连接</button>
      {checking && <button type="button" onClick={() => void cancel()}><X aria-hidden="true" />取消检查</button>}
      <button type="button" aria-label="刷新认证与连接状态" title="刷新认证与连接状态" onClick={() => { void refresh(); void onRefresh(); }}>
        <RefreshCw aria-hidden="true" /></button>
    </div>
    <div className="model-check-state" role="status" data-check-id={check?.checkId} data-check-status={check?.status}>
      {checking ? <LoaderCircle className="spin" aria-hidden="true" /> : check?.status === 'passed' ? <Check aria-hidden="true" /> : <Cable aria-hidden="true" />}
      <strong>{check ? CHECK_LABELS[check.status] : '尚未检查'}</strong>
      {check?.errorCode && <span>{MODEL_ACCESS_MESSAGES[check.errorCode]}</span>}
      {check?.checkedAt && <time dateTime={check.checkedAt}>检查时间：{new Date(check.checkedAt).toLocaleString('zh-CN')}</time>}
      {check?.expiresAt && <time dateTime={check.expiresAt}>有效至：{new Date(check.expiresAt).toLocaleString('zh-CN')}</time>}
    </div>
  </section>;
}
