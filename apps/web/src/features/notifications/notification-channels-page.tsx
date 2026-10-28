import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { NotificationChannel, NotificationDelivery, NotificationDeliveryState, WechatNotificationStatus } from '@multivac/contracts';
import { SettingsCard, SettingsRow } from '../../components/settings-card.js';
import { useConfirm } from '../../components/confirm-card.js';
import { SavedMark, useSavedFlash } from '../../components/saved-mark.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import * as api from '../../data/notification-channels-api.js';
import './notification-channels.css';

const labels: Record<NotificationDeliveryState, string> = { pending: '待发送', waiting: '等待渠道就绪', sending: '发送中', accepted: '已发出', unknown: '结果未知', failed: '失败', cancelled: '已取消', expired: '已过期' };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '尚无';
const shortDate = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 渠道共同规则：放在标题旁的说明气泡里，按主题一行一条。 */
const RULE_ITEMS: [string, string][] = [
  ['发送范围', '只发提醒；澄清、授权、验收等事项不外发，Inbox 原通知始终保留。'],
  ['不补发', '首次启用前和暂停期间的提醒不会补发。'],
  ['有效期', '提醒生成 24 小时后仍未发出，就不再发送。'],
  ['取消', '暂停、解除绑定或点“知道了”会取消未发出的消息；已发出的无法撤回。'],
  ['送达', '“已发出”表示微信已接受，不保证手机收到；结果未知时不自动重发。'],
  ['回复', '微信里的回复不会处理事项；超过 1000 字的内容请在 Inbox 查看全文。'],
];
const RULES = <dl className="notification-rules">
  {RULE_ITEMS.map(([term, text]) => <div key={term}><dt>{term}</dt><dd>{text}</dd></div>)}
</dl>;

export function NotificationChannelsPage({ active }: { active: boolean }) {
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null), [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try { const result = await api.getNotificationChannels(); if (seq === sequence.current) { setChannels(result.items); setError(''); } }
    catch (cause) { if (seq === sequence.current) setError(cause instanceof Error ? cause.message : '读取通知渠道失败。'); }
  }, []);
  useEffect(() => {
    if (!active) return;
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [active, load]);
  return <div className="notification-channels-page" data-management-page="notifications">
    <p>提醒到期时，除了 Inbox，还可以把提醒文本同步发到已启用的渠道。</p>
    {error && <p role="alert" className="form-error">{error}<button className="secondary-button" onClick={() => void load()}>刷新渠道</button></p>}
    {!channels && !error && <p role="status">正在读取通知渠道…</p>}
    {channels?.map(channel => <ChannelSettings key={channel.id} channel={channel} active={active} reload={load} />)}
  </div>;
}

type StepState = 'done' | 'current' | 'todo';
/** “已保存”标记出现的位置。 */
type SavedTarget = 'enabled' | 'binding' | 'test' | 'confirm';

/** 设置步骤：已完成显示结果，当前步骤展开操作，后续步骤只显示标题。 */
function Step({ index, title, state, summary, children }: { index: number; title: string; state: StepState; summary?: ReactNode; children?: ReactNode }) {
  return <li className="notification-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
    <span className="notification-step-mark" aria-hidden="true">{state === 'done' ? <Check /> : index}</span>
    <div className="notification-step-body">
      <strong>{title}</strong>
      {state === 'done' && summary && <small>{summary}</small>}
      {state === 'current' && children}
    </div>
  </li>;
}

function ChannelSettings({ channel, active, reload }: { channel: NotificationChannel; active: boolean; reload: () => Promise<void> }) {
  const [records, setRecords] = useState<NotificationDelivery[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [wechat, setWechat] = useState<WechatNotificationStatus | null>(null), [qrRevision, setQrRevision] = useState(0), [code, setCode] = useState('');
  const lock = useRef(false), sequence = useRef(0), confirm = useConfirm();
  const saved = useSavedFlash<SavedTarget>();
  const isWechat = channel.type === 'wechat';
  const name = isWechat ? '微信' : channel.type;
  const load = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const [page, status] = await Promise.all([api.getNotificationRecords(channel.id, offset), isWechat ? api.getWechatNotificationStatus(channel.id) : Promise.resolve(null)]);
      if (seq !== sequence.current) return;
      setRecords(page.items); setTotal(page.total); setNextOffset(page.nextOffset); setWechat(status); setQrRevision(value => value + 1);
    } catch (cause) { if (seq === sequence.current) setError(cause instanceof Error ? cause.message : '读取投递状态失败。'); }
  }, [channel.id, offset, isWechat]);
  useEffect(() => {
    if (!active) { setCode(''); return; }
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [active, load]);
  useEffect(() => { if (wechat?.state !== 'verify-code') setCode(''); }, [wechat?.state]);
  const disabled = busy || !!pending;
  const test = records.find(record => record.id === channel.testedDeliveryId);

  async function mutate(target: SavedTarget, operation: (input: { commandId: string; version: number }) => Promise<unknown>) {
    if (lock.current || pending) return;
    const commandId = crypto.randomUUID(); lock.current = true; setBusy(true); setError(''); setNotice(''); setPending(commandId);
    try { await operation({ commandId, version: channel.version }); setPending(null); saved.flash(target); setOffset(0); await reload(); await load(); }
    catch (cause) {
      if (cause instanceof AssistantApiError && cause.status >= 400 && cause.status < 500) setPending(null);
      setError(cause instanceof AssistantApiError && cause.status < 500 ? cause.message : '操作结果待核对。请只读核对原操作，不要重复提交。');
    } finally { lock.current = false; setBusy(false); }
  }
  async function checkOperation() {
    if (!pending || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const receipt = await api.getNotificationOperation(pending);
      if (receipt.state === 'running') setNotice('原操作仍在处理，请稍后核对。');
      else { setPending(null); setError(''); setNotice(receipt.state === 'done' ? '原操作已完成，请核对当前状态。' : '上次操作结果未知，已停止自动执行；请核对当前绑定和投递记录。'); }
      await reload(); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '核对失败，请稍后再查。'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function bind(unbind: boolean) {
    if (await confirm({ title: unbind ? '解除微信绑定？' : '绑定本人微信？', description: '将停止未开始的旧投递。已在途的消息可能已发出，不能保证撤回；旧队列不会转移到新身份。', confirmLabel: unbind ? '解除绑定' : '继续绑定', tone: unbind ? 'danger' : 'default' })) {
      await mutate('binding', input => api.manageWechatNotifications(channel.id, unbind ? 'unbind' : 'bind', input));
    }
  }
  async function confirmTest() {
    if (test && await confirm({ title: isWechat ? '确认手机收到此测试？' : '确认收到此测试？', description: `请核对接收端的完整编号：${test.localMessageId}。只有你确认实收后才能启用。`, confirmLabel: '我已收到此编号' })) {
      await mutate('confirm', input => api.confirmNotificationTest(channel.id, { ...input, deliveryId: test.id, received: true }));
    }
  }
  const sendTest = () => void mutate('test', input => api.sendNotificationTest(channel.id, input));

  // 设置进度：绑定 → 初始化 → 测试 → 确认；完成后才出现正式通知开关。
  const bound = !isWechat || channel.readiness === 'ready' || wechat?.state === 'waiting-context' || wechat?.state === 'ready';
  const initialized = channel.readiness === 'ready';
  const tested = test?.state === 'accepted';
  const confirmed = !!channel.receivedConfirmedAt;
  const setupDone = initialized && confirmed;
  const steps = [...(isWechat ? [bound, initialized] : []), tested, confirmed];
  const stepState = (n: number): StepState => steps[n] ? 'done' : steps.slice(0, n).every(Boolean) ? 'current' : 'todo';
  const status = channel.readiness === 'invalid' ? { tone: 'danger', text: '需要重新绑定' }
    : channel.enabled ? { tone: 'success', text: '已启用' } : setupDone ? { tone: 'muted', text: '已暂停' } : { tone: 'muted', text: '未完成设置' };
  const diagnostic = wechat?.diagnostic ?? channel.diagnostic;

  const testControls = <>
    <div className="notification-step-actions">
      <button className="secondary-button" disabled={disabled || channel.enabled || !initialized} title={channel.enabled ? '先暂停正式通知，再发送新的测试消息。' : undefined} onClick={sendTest}>发送新编号测试</button>
      {test && <span className="notification-test-state" data-state={test.state}>{labels[test.state]}</span>}
    </div>
    {test && <small>编号：<code>{test.localMessageId}</code></small>}
  </>;

  return <div className="notification-channel">
    <SettingsCard title={isWechat ? '微信通知' : `通知渠道 · ${channel.type}`}
      description={<><span className="notification-status" data-tone={status.tone}>{status.text}</span>{isWechat ? '提醒到期时，把文本发到你本人的微信。' : '提醒到期时，把文本发到此渠道。'}</>}
      info={RULES}>
      {setupDone ? <>
        <SettingsRow label="正式通知" hint={channel.enabled ? '提醒到期时会同步发送。' : '已暂停，暂停期间的提醒不会补发。'}>
          <SavedMark saved={saved} target="enabled" />
          <button type="button" role="switch" aria-label={`${name}正式通知`} aria-checked={channel.enabled} className="preference-switch"
            disabled={disabled || !channel.enabled && channel.readiness !== 'ready'}
            onClick={() => void mutate('enabled', input => api.setNotificationEnabled(channel.id, { ...input, enabled: !channel.enabled }))}><span aria-hidden="true" /></button>
        </SettingsRow>
        {isWechat && <SettingsRow label="本人微信" hint={`已绑定 · 上下文更新于 ${date(wechat?.contextObservedAt ?? null)}`}>
          <SavedMark saved={saved} target="binding" />
          <button className="secondary-button" disabled={disabled} onClick={() => void bind(false)}>重新绑定</button>
          <button className="secondary-button danger" disabled={disabled} onClick={() => void bind(true)}>解除绑定</button>
        </SettingsRow>}
        <SettingsRow label="测试消息" hint={channel.enabled ? '如需重新测试，请先暂停正式通知。' : '发送一条新编号的测试消息，不创建 Inbox 通知。'}>
          <SavedMark saved={saved} target="test" />
          <button className="secondary-button" disabled={disabled || channel.enabled || !initialized} onClick={sendTest}>发送新编号测试</button>
        </SettingsRow>
      </> : <ol className="notification-steps">
        {isWechat && <Step index={1} title="绑定本人微信" state={stepState(0)} summary="已绑定">
          <small>用本人微信扫描本机生成的二维码，仅用于接收提醒。</small>
          {wechat?.qrAvailable && <img className="notification-qr" src={`${api.wechatQrImage(channel.id, channel.version)}&refresh=${qrRevision}`} alt="用本人微信扫描此绑定二维码" width={200} height={200} />}
          {wechat?.state === 'scanned' && <small>已扫码，请在手机上确认。</small>}
          {wechat?.state === 'verify-code' && <form className="notification-code" onSubmit={event => { event.preventDefault(); const value = code; setCode(''); void mutate('binding', input => api.manageWechatNotifications(channel.id, 'verify', { ...input, code: value })); }}>
            <label>手机显示的验证码<input type="password" inputMode="numeric" pattern="[0-9]{4,12}" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} disabled={disabled} /></label>
            <button className="secondary-button" disabled={disabled || !/^\d{4,12}$/.test(code)}>提交验证码</button>
          </form>}
          {!wechat?.qrAvailable && wechat?.state !== 'scanned' && wechat?.state !== 'verify-code' &&
            <div className="notification-step-actions"><button className="secondary-button" disabled={disabled} onClick={() => void bind(false)}>{wechat?.state === 'expired' || wechat?.state === 'failed' ? '重新绑定' : '绑定微信'}</button></div>}
        </Step>}
        {isWechat && <Step index={2} title="给机器人发一条消息" state={stepState(1)} summary="已初始化">
          <small>在微信里给刚绑定的机器人随便发一条消息，用于建立发送通道；内容不会交给模型。</small>
          <div className="notification-step-actions"><button className="secondary-button" disabled={disabled} onClick={() => void bind(false)}>重新绑定</button></div>
        </Step>}
        <Step index={isWechat ? 3 : 1} title="发送测试消息" state={stepState(isWechat ? 2 : 0)} summary={test && <>已发出 · 编号 <code>{test.localMessageId}</code></>}>
          <small>发送一条带唯一编号的测试消息。</small>
          {testControls}
        </Step>
        <Step index={isWechat ? 4 : 2} title={isWechat ? '确认手机已收到' : '确认已收到'} state={stepState(isWechat ? 3 : 1)}>
          <small>核对{isWechat ? '手机' : '接收端'}上的编号与上面一致后确认，确认后即可开启正式通知。</small>
          <div className="notification-step-actions">
            <button className="primary-button" disabled={disabled || !tested} onClick={() => void confirmTest()}>{isWechat ? '确认手机已收到' : '确认本人已收到'}</button>
            <button className="secondary-button" disabled={disabled} onClick={sendTest}>没收到，重新发送</button>
          </div>
        </Step>
      </ol>}
      {diagnostic && !setupDone && <p className="notification-note">{diagnostic}</p>}
      {(error || notice || pending) && <div className="notification-feedback" aria-live="polite">{error && <p role="alert" className="form-error">{error}</p>}{notice && <p>{notice}</p>}
        {pending && <button className="secondary-button" disabled={busy} onClick={() => void checkOperation()}>核对原操作结果</button>}</div>}
    </SettingsCard>

    <SettingsCard title="投递记录" description={total ? `共 ${total} 条` : undefined}>
      <div className="notification-records">
        {records.length === 0 && <p className="notification-empty">暂无投递记录。</p>}
        {records.map(record => <details key={record.id} className="notification-record">
          <summary>
            <span className="notification-record-kind">{record.kind === 'test' ? '测试' : '提醒'}</span>
            <span className="notification-test-state" data-state={record.state}>{labels[record.state]}</span>
            <time dateTime={record.createdAt}>{shortDate(record.createdAt)}</time>
          </summary>
          {record.diagnostic && <p>{record.diagnostic}</p>}
          <dl><dt>本地编号</dt><dd>{record.localMessageId}</dd><dt>外发期限</dt><dd>{date(record.expiresAt)}</dd>
            <dt>尝试次数</dt><dd>{record.attempts}</dd><dt>绑定代次</dt><dd>{record.bindingGeneration}</dd>
            {record.serverMessageId && <><dt>服务端编号</dt><dd>{record.serverMessageId}</dd></>}
          </dl>
        </details>)}
      </div>
      {(offset > 0 || nextOffset !== null) && <div className="notification-pagination"><button className="secondary-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>较新记录</button>
        <button className="secondary-button" disabled={nextOffset === null} onClick={() => nextOffset !== null && setOffset(nextOffset)}>较早记录</button></div>}
    </SettingsCard>
  </div>;
}
