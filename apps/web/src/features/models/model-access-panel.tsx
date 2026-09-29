import { AlertCircle, Cable, Check, CheckCircle2, KeyRound, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MODEL_CHECK_TTL_MS, type ModelAccessSnapshot, type ModelConnectionCheck, type ModelProfile } from '@multivac/contracts';
import {
  cancelModelCheck, configureModelApiKey, getModelAccessReceipt,
  MODEL_ACCESS_MESSAGES, ModelAccessApiError, revokeModelApiKey, startModelCheck,
} from '../../data/model-access-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import type { SavedFlash } from '../../components/saved-mark.js';
import { ModelSection, type ModelSavedPart } from './model-section.js';

const CHECK_LABELS = {
  checking: '正在检查', passed: '连接成功', failed: '连接失败', cancelled: '已取消',
  'timed-out': '检查超时', invalidated: '检查已失效', expired: '检查已过期',
};

/** 检查时间只写到分钟（如“9/29 21:47”），与原型一致；完整时间在 dateTime 里。 */
function shortTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function checkTone(check: ModelConnectionCheck | undefined): '' | 'ok' | 'failed' {
  if (check?.status === 'passed') return 'ok';
  return check?.status === 'failed' || check?.status === 'timed-out' ? 'failed' : '';
}

/**
 * 模型详情里的“API Key”与“连接检查”两节（按原型）。认证状态与连接检查分开建模：
 * 可用状态由 Pi 按配置与认证判断，连接检查只是按已保存的配置实际连一次，不改变可用状态。
 * 编辑配置时两节仍然显示，但暂停操作并写明原因。
 */
export function ModelAccessPanel({ profile, profileRevision, active, locked, editing, saved, onRefresh, onBusy, onSnapshot, snapshot, refresh, accessIssue }: {
  profileRevision: number;
  profile: ModelProfile; active: boolean; locked: boolean;
  /** 正在编辑这个配置：操作暂停，未提交的 Key 清空。 */
  editing: boolean;
  saved: SavedFlash<ModelSavedPart>;
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
  const confirm = useConfirm();
  useEffect(() => {
    if (!active || editing) setApiKey('');
  }, [active, editing]);
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
  const disabled = locked || busy || pendingId !== null || stale || editing;

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
        else if (action !== 'check' && result.replayed) setNotice('原命令已消费，新的输入没有重复写入。');
        else if (action !== 'check') saved.flash('key');
      }
      await refresh(); await onRefresh();
    } catch (error) {
      const code = error instanceof ModelAccessApiError ? error.code : 'ACCESS_UNAVAILABLE';
      setIssue(MODEL_ACCESS_MESSAGES[code]);
      if (code !== 'CREDENTIAL_RESULT_UNKNOWN') setPendingId(null);
      await refresh();
    } finally { setApiKey(''); setBusy(false); }
  }
  // 确认卡打开期间快照、配置版本与禁用条件都可能变化：确认后按最新状态执行，
  // 此时已经失效（stale、锁定或忙碌）就由 mutate 按最新条件放弃。
  const latestMutate = useRef(mutate);
  useLayoutEffect(() => { latestMutate.current = mutate; });
  async function revoke() {
    const confirmed = await confirm({
      title: '撤销 API Key？',
      description: `撤销提供方 ${profile.provider} 在 Pi 中保存的 API Key。`,
      details: ['撤销后使用该提供方的模型变为未认证，需要重新配置 API Key 才能使用。'],
      tone: 'danger',
      confirmLabel: '撤销',
    });
    if (confirmed) void latestMutate.current('revoke');
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
  const stored = credential?.storedApiKey === true;
  const keyStatus = !credential ? '凭据状态待刷新。'
    : stored ? `已为提供方 ${profile.provider} 保存 API Key，不显示现有值。更换或撤销后需要重新检查连接。`
    : availability?.authenticated ? `没有在这里为提供方 ${profile.provider} 保存 API Key；Pi 当前已通过其他方式完成认证。`
    : `还没有为提供方 ${profile.provider} 配置 API Key。配置后可以检查一次连接。`;
  const checkRule = `检查按已保存的配置实际连接一次，结果 ${MODEL_CHECK_TTL_MS / 60_000} 分钟内有效；可用状态由 Pi 按配置与认证判断，不以检查结果为准。`;
  const tone = checkTone(check);
  return <div className="model-access-panel">
    <ModelSection title="API Key" saved={saved} target="key" className="model-key-section">
      <p className="section-hint">{keyStatus}</p>
      {credential && !credential.configurable && <p className="section-hint" role="status">{MODEL_ACCESS_MESSAGES.CREDENTIAL_UNSUPPORTED}</p>}
      {snapshot && stale && <div className="model-access-target-warning" role="alert">
        <p>模型配置已变化；输入已清空，请刷新并确认当前提供方。</p>
        <button type="button" className="secondary-button compact" disabled={busy || locked} onClick={() => { void refresh(); void onRefresh(); }}>
          <RefreshCw aria-hidden="true" />刷新当前配置</button>
        <button type="button" className="secondary-button compact" disabled={!coherent || busy || locked} onClick={() => {
          setApiKey(''); setConfirmedTarget({ revision: profileRevision, provider: profile.provider });
        }}><Check aria-hidden="true" />确认当前配置</button>
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); void mutate('configure'); }} className="model-key-form">
        <input type="password" aria-label="API Key" autoComplete="off"
          placeholder={stored ? '输入新的 API Key 以更换' : '输入 API Key'}
          value={stale ? '' : apiKey} disabled={disabled || !credential?.configurable} onChange={(event) => setApiKey(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={disabled || !credential?.configurable || !apiKey.trim()}>
          <KeyRound aria-hidden="true" />{stored ? '更换 API Key' : '配置 API Key'}</button>
        {/* 没有保存的 Key 时没有可撤销的，不显示“撤销”（凭据状态待刷新时同样不显示）。 */}
        {stored && <button type="button" className="secondary-button" disabled={disabled} onClick={() => void revoke()}>
          <Trash2 aria-hidden="true" />撤销 API Key</button>}
      </form>
      <small className="model-key-note">
        {editing ? '正在编辑配置：保存或取消后才能配置或撤销 API Key。'
          : 'Key 只交给 Pi 保存：提交后输入框随即清空，页面不显示已保存的值；同一提供方的模型共用这个 Key。'}
      </small>
      {issue && <p role="alert" className="model-access-issue">{issue}</p>}
      {accessIssue && <p role="alert" className="model-access-issue">{accessIssue}</p>}
      {notice && <p role="status" className="model-access-notice">{notice}</p>}
      {pendingId && <button type="button" className="secondary-button compact model-access-reconcile" disabled={busy} onClick={() => void reconcile()}>
        <RefreshCw aria-hidden="true" />查询原命令结果</button>}
    </ModelSection>
    <ModelSection title="连接检查" className="model-check-section">
      <div className="model-check-row">
        <div className={`model-check-state ${tone}`} role="status" data-check-id={check?.checkId} data-check-status={check?.status}>
          {checking ? <LoaderCircle className="spin" aria-hidden="true" />
            : tone === 'ok' ? <CheckCircle2 aria-hidden="true" />
            : tone === 'failed' ? <AlertCircle aria-hidden="true" /> : <Cable aria-hidden="true" />}
          <strong>{check ? CHECK_LABELS[check.status] : '尚未检查'}</strong>
          {check?.errorCode && <span>{MODEL_ACCESS_MESSAGES[check.errorCode]}</span>}
          {check?.checkedAt && <time dateTime={check.checkedAt}>{shortTime(check.checkedAt)}</time>}
          {check?.expiresAt && <time dateTime={check.expiresAt}>有效至 {shortTime(check.expiresAt)}</time>}
        </div>
        <div className="model-check-actions">
          {checking && <button type="button" className="secondary-button" onClick={() => void cancel()}><X aria-hidden="true" />取消检查</button>}
          <button type="button" className="icon-button" aria-label="刷新认证与连接状态" title="刷新认证与连接状态" onClick={() => { void refresh(); void onRefresh(); }}>
            <RefreshCw aria-hidden="true" /></button>
          <button type="button" className="secondary-button" disabled={disabled || checking || !availability?.authenticated}
            onClick={() => void mutate('check')}><Cable aria-hidden="true" />检查连接</button>
        </div>
      </div>
      <p className="section-hint">{editing ? `正在编辑配置：保存或取消后才能检查连接。${checkRule}` : checkRule}</p>
    </ModelSection>
  </div>;
}
