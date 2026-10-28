import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationChannel, NotificationDelivery, NotificationDeliveryState, WechatNotificationStatus } from '@multivac/contracts';
import { SettingsCard, SettingsRow } from '../../components/settings-card.js';
import { useConfirm } from '../../components/confirm-card.js';
import { AssistantApiError } from '../../data/assistant-api.js';
import * as api from '../../data/notification-channels-api.js';
import './notification-channels.css';

const labels: Record<NotificationDeliveryState, string> = { pending: '待发送', waiting: '等待渠道就绪', sending: '发送中', accepted: '接口已接受', unknown: '结果未知，不自动重发', failed: '失败', cancelled: '已取消', expired: '已过期' };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '尚无';

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
    <p>提醒到期后，Inbox 保留原通知，已启用的渠道额外发送文本副本。其他授权与确认事项不会外发。</p>
    {error && <p role="alert" className="form-error">{error}<button className="secondary-button" onClick={() => void load()}>刷新渠道</button></p>}
    {!channels && !error && <p role="status">正在读取通知渠道…</p>}
    {channels?.map(channel => <ChannelSettings key={channel.id} channel={channel} active={active} reload={load} />)}
  </div>;
}

function ChannelSettings({ channel, active, reload }: { channel: NotificationChannel; active: boolean; reload: () => Promise<void> }) {
  const [records, setRecords] = useState<NotificationDelivery[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0), [total, setTotal] = useState(0), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(null);
  const [wechat, setWechat] = useState<WechatNotificationStatus | null>(null), [qrRevision, setQrRevision] = useState(0), [code, setCode] = useState('');
  const lock = useRef(false), sequence = useRef(0), confirm = useConfirm();
  const isWechat = channel.type === 'wechat';
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
  async function mutate(operation: (input: { commandId: string; version: number }) => Promise<unknown>) {
    if (lock.current || pending) return;
    const commandId = crypto.randomUUID(); lock.current = true; setBusy(true); setError(''); setNotice(''); setPending(commandId);
    try { await operation({ commandId, version: channel.version }); setPending(null); setNotice('操作已保存'); setOffset(0); await reload(); await load(); }
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
      await mutate(input => api.manageWechatNotifications(channel.id, unbind ? 'unbind' : 'bind', input));
    }
  }
  return <div className="notification-channel">
    <SettingsCard title={isWechat ? '本人微信' : `通知渠道 · ${channel.type}`} description="只有提醒文本副本。首次启用及暂停期间的通知不会补发。"
      details="通知生成后24小时停止外发，原通知保留。暂停或在 Multivac 点知道了会取消尚未开始的投递；在途请求保留真实结果，不能保证撤回。结果未知不会自动重发。微信回复不产生业务决定。">
      <SettingsRow label="正式通知" hint="先初始化、主动发送测试，再在这里确认手机收到，才可启用。">
        <button type="button" role="switch" aria-label={`${isWechat ? '微信' : channel.type}正式通知`} aria-checked={channel.enabled} className="preference-switch"
          disabled={disabled || !channel.enabled && (!channel.receivedConfirmedAt || channel.readiness !== 'ready')}
          onClick={() => void mutate(input => api.setNotificationEnabled(channel.id, { ...input, enabled: !channel.enabled }))}><span aria-hidden="true" /></button>
      </SettingsRow>
      <SettingsRow label="本地状态" hint={channel.diagnostic ?? undefined}><span>{channel.readiness === 'ready' ? '本地资料就绪' : channel.readiness === 'invalid' ? '凭据失效，已暂停发送' : '等待初始化'}</span></SettingsRow>
      <SettingsRow label="测试接口" hint={test ? `当前编号：${test.localMessageId}` : '每次测试使用新编号，不创建 Inbox 通知。'}>
        <span>{test ? labels[test.state] : channel.testedDeliveryId ? '请在最近记录核对测试结果' : '尚未测试'}</span>
        <button className="secondary-button" title={channel.enabled ? '先暂停正式通知，再发送新的编号测试。' : undefined} disabled={disabled || channel.enabled || channel.readiness !== 'ready'} onClick={() => void mutate(input => api.sendNotificationTest(channel.id, input))}>发送新编号测试</button>
      </SettingsRow>
      <SettingsRow label={isWechat ? '本人手机确认' : '本人接收确认'} hint={`确认时间：${date(channel.receivedConfirmedAt)}。接口接受不等于本人收到。`}>
        <button className="secondary-button" disabled={disabled || test?.state !== 'accepted' || !!channel.receivedConfirmedAt}
          onClick={async () => { if (test && await confirm({ title: isWechat ? '确认手机收到此测试？' : '确认收到此测试？', description: `请核对接收端的完整编号：${test.localMessageId}。只有你确认实收后才能启用。`, confirmLabel: '我已收到此编号' })) await mutate(input => api.confirmNotificationTest(channel.id, { ...input, deliveryId: test.id, received: true })); }}>{isWechat ? '确认手机已收到' : '确认本人已收到'}</button>
      </SettingsRow>
    </SettingsCard>
    {isWechat && <SettingsCard title="微信绑定" description="使用本人微信扫码，只用于提醒。文本最多1000个Unicode字符，超长内容全文保留在 Inbox。">
      <SettingsRow label="绑定与初始化" hint={wechat?.diagnostic ?? '请先绑定，再用同一微信向机器人发送一条消息。'}>
        <button className="secondary-button" disabled={disabled} onClick={() => void bind(false)}>绑定或重新绑定</button>
        <button className="secondary-button danger" disabled={disabled} onClick={() => void bind(true)}>解除绑定</button>
      </SettingsRow>
      {wechat?.qrAvailable && <img className="notification-qr" src={`${api.wechatQrImage(channel.id, channel.version)}&refresh=${qrRevision}`} alt="用本人微信扫描此绑定二维码" width={256} height={256} />}
      {wechat?.state === 'verify-code' && <form className="notification-code" onSubmit={event => { event.preventDefault(); const value = code; setCode(''); void mutate(input => api.manageWechatNotifications(channel.id, 'verify', { ...input, code: value })); }}>
        <label>手机显示的验证码<input type="password" inputMode="numeric" pattern="[0-9]{4,12}" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} disabled={disabled} /></label>
        <button className="secondary-button" disabled={disabled || !/^\d{4,12}$/.test(code)}>提交验证码</button>
      </form>}
      <p className="notification-note">本人上下文观察时间：{date(wechat?.contextObservedAt ?? null)}。轮询不会延长该时间，也不保证微信接受未来发送。</p>
    </SettingsCard>}
    {(error || notice || pending) && <div aria-live="polite">{error && <p role="alert" className="form-error">{error}</p>}{notice && <p>{notice}</p>}
      {pending && <button className="secondary-button" disabled={busy} onClick={() => void checkOperation()}>核对原操作结果</button>}</div>}
    <SettingsCard title="投递记录" description={`共${total}条。接口接受只表示服务端接受，不能证明手机实收。`}>
      <div className="notification-records">
        {records.length === 0 && <p>暂无投递记录。</p>}
        {records.map(record => <article key={record.id} className="notification-record">
          <strong>{record.kind === 'test' ? '测试' : '提醒副本'} · {labels[record.state]}</strong>
          <dl><dt>本地编号</dt><dd>{record.localMessageId}</dd><dt>记录创建</dt><dd>{date(record.createdAt)}</dd>
            <dt>外发期限</dt><dd>{date(record.expiresAt)}</dd><dt>尝试 / 绑定代次</dt><dd>{record.attempts} / {record.bindingGeneration}</dd>
            {record.serverMessageId && <><dt>服务端编号</dt><dd>{record.serverMessageId}</dd></>}
          </dl>{record.diagnostic && <p>{record.diagnostic}</p>}
        </article>)}
      </div>
      <div className="notification-pagination"><button className="secondary-button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>较新记录</button>
        <button className="secondary-button" disabled={nextOffset === null} onClick={() => nextOffset !== null && setOffset(nextOffset)}>较早记录</button></div>
    </SettingsCard>
  </div>;
}
