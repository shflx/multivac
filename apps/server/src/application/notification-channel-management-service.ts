import type { NotificationChannelOperation } from '@multivac/contracts';
import type { NotificationChannelRepository } from '../modules/notifications/repository.js';
import { WechatBindingService, WECHAT_CHANNEL_ID } from './wechat-binding-service.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';

/** 只由本机HTTP设置入口调用；不注册为模型工具或远程操作。 */
export class NotificationChannelManagementService {
  private readonly active = new Set<Promise<NotificationChannelOperation>>();
  constructor(private readonly repository: NotificationChannelRepository, private readonly wechat: WechatBindingService,
    private readonly now: () => string = () => new Date().toISOString()) {}
  list() { return { items: this.repository.channels() }; }
  records(id: string, offset: number, limit: number) {
    if (!this.repository.channel(id)) throw new TaskServiceError('NOT_FOUND', '通知渠道不存在。');
    return this.repository.deliveries(id, offset, limit);
  }
  setEnabled(id: string, input: { commandId: string; version: number; enabled: boolean }) {
    return this.repository.command(input.commandId, JSON.stringify(['enabled', id, input]),
      () => this.repository.setEnabled(id, input.version, input.enabled, this.now()));
  }
  test(id: string, input: { commandId: string; version: number }) {
    return this.repository.command(input.commandId, JSON.stringify(['test', id, input]),
      () => this.repository.createTest(id, input.version, this.now()));
  }
  confirm(id: string, input: { commandId: string; version: number; deliveryId: string; received: true }) {
    return this.repository.command(input.commandId, JSON.stringify(['confirm', id, input]),
      () => this.repository.confirmTest(id, input.version, input.deliveryId, this.now()));
  }
  operation(id: string) { return this.repository.operation(id); }
  private requireWechat(id: string): void {
    if (id !== WECHAT_CHANNEL_ID) throw new TaskServiceError('NOT_FOUND', '此渠道没有微信绑定流程。');
  }
  wechatStatus(id: string) { this.requireWechat(id); return this.wechat.status(); }
  qrContent(id: string) { this.requireWechat(id); return this.wechat.qrContent(); }
  manageWechat(id: string, action: 'bind' | 'unbind' | 'verify', input: { commandId: string; version: number; code?: string }): Promise<NotificationChannelOperation> {
    const work = this.performWechat(id, action, input);
    this.active.add(work);
    return work.finally(() => this.active.delete(work));
  }
  get hasActivity(): boolean { return this.active.size > 0; }
  async close(): Promise<void> { await Promise.allSettled([...this.active]); }
  private async performWechat(id: string, action: 'bind' | 'unbind' | 'verify', input: { commandId: string; version: number; code?: string }): Promise<NotificationChannelOperation> {
    this.requireWechat(id);
    // 不把验证码写入命令指纹或业务库。同命令只执行一次，不重复发送验证码。
    if (!this.repository.beginOperation(input.commandId, JSON.stringify([action, id, input.version]))) return this.repository.operation(input.commandId);
    try {
      this.repository.requireVersion(id, input.version);
      if (action === 'bind') await this.wechat.begin(input.version);
      else if (action === 'unbind') await this.wechat.unbind(input.version);
      else this.wechat.verify(input.version, input.code ?? '');
      this.repository.finishOperation(input.commandId, 'done');
    } catch (error) { this.repository.finishOperation(input.commandId, 'unknown'); throw error; }
    return this.repository.operation(input.commandId);
  }
}
