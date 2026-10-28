import { randomUUID } from 'node:crypto';
import type { NotificationChannelAdapter, ChannelSendResult } from '../modules/notifications/channel.js';
import type { NotificationChannelRepository } from '../modules/notifications/repository.js';
import type { WorkbenchEvents } from './workbench-events.js';

/** 一个渠道一个在途请求；网络等待相互独立，不占用提醒生成事务。 */
export class NotificationDeliveryService {
  private readonly adapters = new Map<string, NotificationChannelAdapter>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  constructor(private readonly repository: NotificationChannelRepository,
    adapters: NotificationChannelAdapter[], private readonly now: () => string = () => new Date().toISOString(),
    private readonly timeoutMs = 30_000, private readonly onError: () => void = () => console.warn('通知渠道本地执行失败，请核对投递记录。')) {
    for (const adapter of adapters) this.adapters.set(adapter.type, adapter);
  }
  start(events: WorkbenchEvents): void {
    if (this.timer) return;
    this.stopped = false;
    this.repository.recover(this.now());
    this.unsubscribe = events.subscribe(event => { if (event.type === 'inbox.changed') void this.tick(); });
    void this.tick();
    // 事件只唤醒。启动补查及持续对账覆盖提交后未分发的进程退出。
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    try { this.repository.reconcile(this.now()); } catch { this.onError(); return; }
    for (const channel of this.repository.channels()) {
      if (this.active.has(channel.id)) continue;
      const work = this.process(channel.id).catch(() => this.onError()).finally(() => this.active.delete(channel.id));
      this.active.set(channel.id, work);
    }
    await Promise.allSettled([...this.active.values()]);
  }
  private async process(id: string): Promise<void> {
    const owner = randomUUID();
    const record = this.repository.acquire(id, owner, this.now());
    if (!record) return;
    try {
      const channel = this.repository.channel(id)!;
      const adapter = this.adapters.get(channel.type);
      const ready = !adapter ? { state: 'waiting', diagnostic: '渠道适配器尚未提供。' } as const :
        channel.readiness === 'invalid' ? { state: 'invalid', diagnostic: '渠道凭据已失效，请重新绑定。' } as const : adapter.readiness(channel);
      this.repository.setReadiness(id, ready.state, ready.state === 'ready' ? null : ready.diagnostic);
      if (!adapter || ready.state !== 'ready') {
        this.repository.wait(record.id, owner, this.now(), ready.state === 'ready' ? '等待渠道。' : ready.diagnostic); return;
      }
      let text: string;
      try { text = adapter.format(this.repository.content(record.id)); }
      catch {
        this.repository.saveDelivery({ ...record, state: 'failed', completedAt: this.now(), diagnostic: '通知格式化失败，未请求外部接口。' }); return;
      }
      if (this.stopped) return;
      // 持久发送意图与尝试后，才允许适配器开始请求。这里到 send 之间无异步等待。
      const sending = this.repository.beginSend(record.id, owner, this.now());
      if (!sending) return;
      const controller = new AbortController(); this.controllers.add(controller);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const uncertain: ChannelSendResult = { outcome: 'unknown', diagnostic: '本地等待已结束，远端结果未知；不会自动重发。' };
      try {
        const cancelled = new Promise<ChannelSendResult>(resolve => controller.signal.addEventListener('abort', () => resolve(uncertain), { once: true }));
        timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const result = await Promise.race([
          adapter.send(text, { channel: this.repository.channel(id)!, localMessageId: sending.localMessageId, signal: controller.signal }).catch(() => uncertain),
          cancelled,
        ]);
        this.repository.finish(sending, owner, result, this.now());
      } finally {
        if (timer) clearTimeout(timer);
        this.controllers.delete(controller);
      }
    } finally { this.repository.release(id, owner); }
  }
  get hasActivity(): boolean { return this.active.size > 0; }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }
}
