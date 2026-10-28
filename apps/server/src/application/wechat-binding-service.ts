import type { NotificationChannel, WechatNotificationStatus } from '@multivac/contracts';
import { IlinkClient, IlinkError, ILINK_BASE, checkedIlinkBase, checkedQrUrl, explicitSuccess, invalidCredentials, stringField } from '../modules/notifications/wechat/client.js';
import type { ChannelReadiness } from '../modules/notifications/channel.js';
import { sameWechatIdentity, type PrivateWechatBinding, type WechatBindingIdentity, type PrivateWechatBindingStore, type WechatBindingRepository } from '../modules/notifications/wechat/binding.js';
import type { NotificationChannelRepository } from '../modules/notifications/repository.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';

export const WECHAT_CHANNEL_ID = 'wechat-self';
type Login = { generation: number; qrcode: string; qrUrl: string; base: string; expiresAt: number; refreshes: number; code?: string };
const sleep = (signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, 1000); timer.unref(); signal.addEventListener('abort', finish, { once: true });
});

/** 入站数据只用于核对本人和维护上下文，不提供模型、Inbox或任务决定接口。 */
export class WechatBindingService {
  private login: Login | null = null;
  private statusValue: WechatNotificationStatus = { state: 'unbound', qrAvailable: false, diagnostic: null, contextObservedAt: null };
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private readonly lifetime = new AbortController();
  constructor(private readonly channels: NotificationChannelRepository, private readonly identities: WechatBindingRepository,
    private readonly secrets: PrivateWechatBindingStore, readonly client: IlinkClient = new IlinkClient(), private readonly now: () => string = () => new Date().toISOString(), private readonly autoPoll = true) {}
  /** 必须由启动装配或本机用户操作显式调用；查询不会创建配置或发起登录。 */
  initialize(): void {
    this.channels.ensureChannel(WECHAT_CHANNEL_ID, 'wechat');
    const channel = this.channels.channel(WECHAT_CHANNEL_ID)!;
    const readiness = this.readiness(channel);
    this.channels.setReadiness(channel.id, readiness.state, readiness.state === 'ready' ? null : readiness.diagnostic);
    this.statusValue = { state: readiness.state === 'ready' ? 'ready' : this.binding(channel) ? 'waiting-context' : 'unbound', qrAvailable: false,
      diagnostic: readiness.state === 'ready' ? null : readiness.diagnostic, contextObservedAt: this.binding(channel)?.contextObservedAt ?? null };
    if (this.autoPoll && this.binding(channel) && channel.readiness !== 'invalid') this.startLoop();
  }
  binding(channel: NotificationChannel): PrivateWechatBinding | null {
    try {
      const binding = this.secrets.load(), identity = this.identities.get(channel.id);
      return binding && identity && binding.channelId === channel.id && binding.generation === channel.bindingGeneration &&
        sameWechatIdentity(binding, identity) ? binding : null;
    } catch { return null; }
  }
  readiness(channel: NotificationChannel): ChannelReadiness {
    if (channel.readiness === 'invalid') return { state: 'invalid', diagnostic: '微信凭据已失效，请重新绑定。' };
    const binding = this.binding(channel);
    if (!binding) return { state: 'waiting', diagnostic: '请在本机完成本人微信绑定。' };
    if (!binding.contextToken) return { state: 'waiting', diagnostic: '请用扫码的本人微信向机器人发送一条消息以初始化上下文。' };
    return { state: 'ready' };
  }
  status(): WechatNotificationStatus { return { ...this.statusValue }; }
  qrContent(): string | null { return this.login?.qrUrl ?? null; }
  async begin(version: number): Promise<WechatNotificationStatus> {
    if (this.lifetime.signal.aborted) throw new TaskServiceError('INVALID_REQUEST', '通知渠道服务正在关闭。');
    const previous = this.binding(this.channels.requireVersion(WECHAT_CHANNEL_ID, version));
    const channel = this.channels.resetBinding(WECHAT_CHANNEL_ID, version, this.now());
    this.login = null;
    await this.stopLoop(previous);
    // 并发重绑时，仅最新代次能继续。旧返回不会覆盖新资料。
    if (this.lifetime.signal.aborted) throw new TaskServiceError('INVALID_REQUEST', '服务已关闭，请只读核对原绑定操作。');
    if (this.channels.channel(WECHAT_CHANNEL_ID)?.bindingGeneration !== channel.bindingGeneration) return this.status();
    try {
      const login = await this.fetchQr(channel.bindingGeneration, 0);
      if (this.lifetime.signal.aborted) throw new TaskServiceError('INVALID_REQUEST', '服务已关闭，请只读核对原绑定操作。');
      if (this.channels.channel(WECHAT_CHANNEL_ID)?.bindingGeneration !== channel.bindingGeneration) return this.status();
      this.login = login;
      this.statusValue = { state: 'qr', qrAvailable: true, diagnostic: null, contextObservedAt: null };
      if (this.autoPoll) this.startLoop();
    } catch {
      if (this.lifetime.signal.aborted) throw new TaskServiceError('INVALID_REQUEST', '服务已关闭，请只读核对原绑定操作。');
      if (this.channels.channel(WECHAT_CHANNEL_ID)?.bindingGeneration === channel.bindingGeneration) this.fail('获取微信二维码失败，请稍后重新绑定。');
    }
    return this.status();
  }
  verify(version: number, code: string): void {
    const channel = this.channels.requireVersion(WECHAT_CHANNEL_ID, version);
    if (!this.login || this.login.generation !== channel.bindingGeneration || this.statusValue.state !== 'verify-code') throw new TaskServiceError('TASK_CONFLICT', '当前没有待输入的微信验证码。');
    if (!/^\d{4,12}$/.test(code)) throw new TaskServiceError('TASK_CONFLICT', '请输入手机显示的数字验证码。');
    this.login.code = code;
  }
  async unbind(version: number): Promise<void> {
    const previous = this.binding(this.channels.requireVersion(WECHAT_CHANNEL_ID, version));
    const next = this.channels.resetBinding(WECHAT_CHANNEL_ID, version, this.now()); this.login = null;
    await this.stopLoop(previous);
    if (this.lifetime.signal.aborted) throw new TaskServiceError('INVALID_REQUEST', '服务已关闭，请只读核对原解绑操作。');
    if (this.channels.channel(WECHAT_CHANNEL_ID)?.bindingGeneration !== next.bindingGeneration) return;
    this.identities.clear(WECHAT_CHANNEL_ID); this.secrets.clear();
    this.statusValue = { state: 'unbound', qrAvailable: false, diagnostic: null, contextObservedAt: null };
  }
  private async fetchQr(generation: number, refreshes: number, signal: AbortSignal = this.lifetime.signal): Promise<Login> {
    const reply = await this.client.request(ILINK_BASE, 'get_bot_qrcode', { body: { local_token_list: [] }, query: { bot_type: '3' }, signal: AbortSignal.any([signal, this.lifetime.signal]) });
    const qrcode = stringField(reply.body.qrcode), qrUrl = stringField(reply.body.qrcode_img_content);
    if (reply.status !== 200 || !qrcode || !qrUrl) throw new IlinkError('response');
    return { generation, qrcode, qrUrl: checkedQrUrl(qrUrl), base: ILINK_BASE, expiresAt: Date.parse(this.now()) + 5 * 60_000, refreshes };
  }
  private fail(diagnostic: string): void {
    this.login = null; this.statusValue = { state: 'failed', qrAvailable: false, diagnostic, contextObservedAt: null };
    this.channels.setReadiness(WECHAT_CHANNEL_ID, 'waiting', diagnostic);
  }
  /** 单轮入口供协议夹具验证；生产循环始终串行调用。 */
  async pollOnce(signal: AbortSignal): Promise<void> {
    const channel = this.channels.channel(WECHAT_CHANNEL_ID);
    if (!channel) return;
    const login = this.login;
    if (login) {
      if (login.generation !== channel.bindingGeneration) return;
      const query: Record<string, string> = { qrcode: login.qrcode };
      if (login.code) query.verify_code = login.code;
      const reply = Date.parse(this.now()) >= login.expiresAt ? { status: 200, body: { status: 'expired' } } :
        await this.client.request(login.base, 'get_qrcode_status', { query, signal });
      if (signal.aborted || this.login !== login || this.channels.channel(channel.id)?.bindingGeneration !== login.generation) return;
      if (reply.status !== 200) throw new IlinkError('response');
      const state = reply.body.status;
      if (state === 'expired' || state === 'verify_code_blocked') {
        if (login.refreshes >= 2) { this.login = null; this.statusValue = { state: 'expired', qrAvailable: false, diagnostic: '二维码刷新次数已达上限，请重新发起绑定。', contextObservedAt: null }; return; }
        const refreshed = await this.fetchQr(login.generation, login.refreshes + 1, signal);
        if (this.login !== login || signal.aborted) return;
        this.login = refreshed; this.statusValue = { state: 'qr', qrAvailable: true, diagnostic: null, contextObservedAt: null }; return;
      }
      if (state === 'scaned_but_redirect') {
        const host = stringField(reply.body.redirect_host);
        if (!host) throw new IlinkError('address');
        login.base = checkedIlinkBase(`https://${host}`); return;
      }
      if (state === 'need_verifycode') { delete login.code; this.statusValue.state = 'verify-code'; return; }
      if (state === 'scaned') { delete login.code; this.statusValue.state = 'scanned'; return; }
      if (state === 'wait') return;
      if (state === 'confirmed' || state === 'binded_redirect') {
        const botId = stringField(reply.body.ilink_bot_id), userId = stringField(reply.body.ilink_user_id), base = stringField(reply.body.baseurl);
        if (!botId || !userId || !base) { this.fail('微信未返回完整本人绑定身份，不能恢复旧凭据，请重新绑定。'); return; }
        const identity: WechatBindingIdentity = { channelId: channel.id, generation: login.generation, botId, userId, apiBase: checkedIlinkBase(base) };
        const token = stringField(reply.body.bot_token);
        if (!token) {
          const existing = this.binding(channel);
          if (!existing || !sameWechatIdentity(existing, identity)) { this.fail('微信没有签发完整且匹配的绑定凭据，请重新绑定。'); return; }
        } else {
          this.secrets.save({ ...identity, token, cursor: '', seenIds: [], contextToken: null, contextObservedAt: null });
          this.identities.save(identity);
        }
        this.login = null;
        this.statusValue = { state: 'waiting-context', qrAvailable: false, diagnostic: '请用扫码的本人微信向机器人发送一条消息。', contextObservedAt: null };
        await this.notify('msg/notifystart', this.binding(channel), signal);
        return;
      }
      throw new IlinkError('response');
    }
    const binding = this.binding(channel);
    if (!binding || channel.readiness === 'invalid') return;
    const reply = await this.client.request(binding.apiBase, 'getupdates', { token: binding.token, body: { get_updates_buf: binding.cursor }, signal });
    if (signal.aborted || this.channels.channel(channel.id)?.bindingGeneration !== binding.generation) return;
    if (invalidCredentials(reply)) {
      this.channels.setReadiness(channel.id, 'invalid', '微信凭据失效，轮询已暂停，请重新绑定。');
      this.statusValue = { state: 'failed', qrAvailable: false, diagnostic: '微信凭据失效，轮询已暂停，请重新绑定。', contextObservedAt: binding.contextObservedAt }; return;
    }
    if (!explicitSuccess(reply)) throw new IlinkError('response');
    const messages = reply.body.msgs;
    if (messages !== undefined && !Array.isArray(messages)) throw new IlinkError('response');
    const next = { ...binding, seenIds: [...binding.seenIds] };
    const seen = new Set(next.seenIds);
    for (const raw of messages ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const message = raw as Record<string, unknown>;
      // 不使用入站正文。群聊、非本人、非发给本Bot及非用户消息均无作用。
      if (message.from_user_id !== binding.userId || message.to_user_id !== binding.botId || message.message_type !== 1 || stringField(message.group_id)) continue;
      const id = stringField(message.message_id);
      if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const token = stringField(message.context_token);
      if (token && token !== next.contextToken) { next.contextToken = token; next.contextObservedAt = this.now(); }
    }
    next.seenIds = [...seen];
    // 空游标和空上下文不覆盖有效值；全部私有事实一次原子替换。
    next.cursor = stringField(reply.body.get_updates_buf) ?? binding.cursor;
    this.secrets.save(next);
    this.channels.setReadiness(channel.id, next.contextToken ? 'ready' : 'waiting', next.contextToken ? null : '等待本人初始化上下文。');
    this.statusValue = { state: next.contextToken ? 'ready' : 'waiting-context', qrAvailable: false,
      diagnostic: next.contextToken ? null : '等待本人初始化上下文。', contextObservedAt: next.contextObservedAt };
  }
  private async notify(endpoint: 'msg/notifystart' | 'msg/notifystop', binding: PrivateWechatBinding | null, signal?: AbortSignal): Promise<void> {
    if (!binding) return;
    try { await this.client.request(binding.apiBase, endpoint, { token: binding.token, body: {}, ...(signal ? { signal } : {}) }); }
    catch { /* 生命周期通知失败不等于绑定失败，也不更新上下文有效时间。 */ }
  }
  private startLoop(): void {
    if (this.running) return;
    const controller = new AbortController(); this.controller = controller;
    const initial = this.channels.channel(WECHAT_CHANNEL_ID);
    const startedBinding = initial ? this.binding(initial) : null;
    this.running = (async () => {
      await this.notify('msg/notifystart', startedBinding, controller.signal);
      while (!controller.signal.aborted) {
        const current = this.channels.channel(WECHAT_CHANNEL_ID);
        if (!current || current.readiness === 'invalid' || (!this.login && !this.binding(current))) break;
        try { await this.pollOnce(controller.signal); }
        catch (error) {
          if (!controller.signal.aborted && !(error instanceof IlinkError && error.kind === 'timeout')) {
            if (this.login && error instanceof IlinkError && error.kind === 'address') { this.fail('微信返回了未核验的地址，绑定已停止。'); break; }
            this.statusValue.diagnostic = '微信轮询暂不可用，正在等待恢复；原通知保留在 Inbox。';
          }
        }
        await sleep(controller.signal);
      }
    })().finally(() => { this.running = null; this.controller = null; });
  }
  private async stopLoop(previous?: PrivateWechatBinding | null): Promise<void> {
    const current = this.channels.channel(WECHAT_CHANNEL_ID);
    const binding = previous === undefined ? (current ? this.binding(current) : null) : previous;
    this.controller?.abort(); await this.running;
    await this.notify('msg/notifystop', binding);
  }
  get hasActivity(): boolean { return this.running !== null; }
  async close(): Promise<void> { this.lifetime.abort(); this.login = null; await this.stopLoop(); }
}
