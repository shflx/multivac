import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InboxNotification, NotificationChannel, NotificationContent, NotificationDelivery } from '@multivac/contracts';
import { NOTIFICATION_DELIVERY_TTL_MS } from '@multivac/contracts';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { runInTransaction } from './sqlite-transaction.js';

const queued = new Set(['pending', 'waiting']);

/** 只处理提醒通知表。外部人工请求与授权表不属于本仓储的分发来源。 */
export class SqliteNotificationChannelRepository {
  constructor(private readonly db: DatabaseSync) {}
  transaction<T>(operation: () => T): T { return runInTransaction(this.db, operation); }
  command<T>(id: string, fingerprint: string, operation: () => T): T {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM notification_channel_command WHERE id=?').get(id);
      if (row) {
        if (row.fingerprint !== fingerprint) throw new TaskServiceError('COMMAND_ID_CONFLICT', '通知渠道命令内容已变化。');
        return JSON.parse(String(row.result_json)) as T;
      }
      const result = operation();
      this.db.prepare('INSERT INTO notification_channel_command VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  channels(): NotificationChannel[] {
    return this.db.prepare('SELECT record_json FROM notification_channel ORDER BY id').all().map(row => JSON.parse(String(row.record_json)));
  }
  channel(id: string): NotificationChannel | null {
    const row = this.db.prepare('SELECT record_json FROM notification_channel WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as NotificationChannel : null;
  }
  ensureChannel(id: string, type: string): NotificationChannel {
    const initial: NotificationChannel = { id, type, enabled: false, version: 1, bindingGeneration: 1, scope: 'notification',
      readiness: 'waiting', diagnostic: null, testedDeliveryId: null, phoneConfirmedAt: null };
    this.db.prepare('INSERT OR IGNORE INTO notification_channel VALUES (?,?,NULL)').run(id, JSON.stringify(initial));
    return this.channel(id)!;
  }
  private saveChannel(channel: NotificationChannel): void {
    this.db.prepare('UPDATE notification_channel SET record_json=? WHERE id=?').run(JSON.stringify(channel), channel.id);
  }
  requireVersion(id: string, version: number): NotificationChannel {
    const current = this.channel(id);
    if (!current) throw new TaskServiceError('NOT_FOUND', '通知渠道不存在。');
    if (current.version !== version) throw new TaskServiceError('TASK_CONFLICT', '通知渠道已变化，请刷新。');
    return current;
  }
  /** 就绪是本地资料状态，不能替代手机确认。不会改变队列身份或启停区间。 */
  setReadiness(id: string, readiness: NotificationChannel['readiness'], diagnostic: string | null): void {
    const current = this.channel(id);
    if (current) this.saveChannel({ ...current, readiness, diagnostic });
  }
  private lastSequence(): number {
    return Number(this.db.prepare('SELECT coalesce(max(rowid),0) AS seq FROM inbox_notification').get()!.seq);
  }
  private closeRange(id: string): void {
    this.db.prepare('UPDATE notification_channel_range SET end_seq=? WHERE channel_id=? AND end_seq IS NULL').run(this.lastSequence(), id);
  }
  setEnabled(id: string, version: number, enabled: boolean, now: string): NotificationChannel {
    return this.transaction(() => {
      const current = this.requireVersion(id, version);
      if (current.enabled === enabled) return current;
      if (enabled && (!current.phoneConfirmedAt || current.readiness !== 'ready')) {
        throw new TaskServiceError('TASK_CONFLICT', '请先初始化渠道、发送测试，并在 Multivac 确认手机收到。');
      }
      const next = { ...current, enabled, version: current.version + 1 };
      this.closeRange(id);
      if (enabled) {
        const seq = this.lastSequence();
        this.db.prepare('INSERT INTO notification_channel_range(channel_id,config_version,binding_generation,start_seq,end_seq,scanned_seq) VALUES (?,?,?,?,NULL,?)')
          .run(id, next.version, next.bindingGeneration, seq, seq);
      }
      this.saveChannel(next);
      if (!enabled) this.cancelQueued(id, now, '渠道已暂停；在途请求保留真实结果。');
      return next;
    });
  }
  /** 重绑先关闭旧范围，旧记录保留原代次；不新建历史副本。 */
  resetBinding(id: string, version: number, now: string): NotificationChannel {
    return this.transaction(() => {
      const current = this.requireVersion(id, version);
      this.closeRange(id);
      this.cancelQueued(id, now, '绑定已变化，旧投递不转移到新身份。');
      const next: NotificationChannel = { ...current, version: current.version + 1, bindingGeneration: current.bindingGeneration + 1,
        enabled: false, readiness: 'waiting', diagnostic: null, testedDeliveryId: null, phoneConfirmedAt: null };
      this.saveChannel(next);
      return next;
    });
  }
  delivery(id: string): NotificationDelivery | null {
    const row = this.db.prepare('SELECT record_json FROM notification_delivery WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as NotificationDelivery : null;
  }
  deliveries(channelId: string, offset = 0, limit = 20) {
    const total = Number(this.db.prepare('SELECT count(*) AS n FROM notification_delivery WHERE channel_id=?').get(channelId)!.n);
    const items = this.db.prepare('SELECT record_json FROM notification_delivery WHERE channel_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(channelId, limit, offset).map(row => JSON.parse(String(row.record_json)) as NotificationDelivery);
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  content(id: string): NotificationContent {
    const row = this.db.prepare('SELECT content_json FROM notification_delivery WHERE id=?').get(id);
    if (!row) throw new TaskServiceError('NOT_FOUND', '投递不存在。');
    return JSON.parse(String(row.content_json));
  }
  saveDelivery(record: NotificationDelivery): void {
    this.db.prepare('UPDATE notification_delivery SET state=?,next_attempt_at=?,record_json=? WHERE id=?')
      .run(record.state, record.nextAttemptAt, JSON.stringify(record), record.id);
  }
  private insertDelivery(channelId: string, configVersion: number, generation: number, content: NotificationContent,
    kind: NotificationDelivery['kind'], now: string): NotificationDelivery {
    const id = `${kind === 'test' ? 'test' : 'delivery'}:${randomUUID()}`;
    const record: NotificationDelivery = { id, kind, notificationId: kind === 'notification' ? content.notificationId : null,
      channelId, configVersion, bindingGeneration: generation, state: 'pending', localMessageId: `multivac:${randomUUID()}`,
      serverMessageId: null, attempts: 0, createdAt: now, expiresAt: new Date(Date.parse(content.createdAt) + NOTIFICATION_DELIVERY_TTL_MS).toISOString(),
      nextAttemptAt: now, startedAt: null, completedAt: null, diagnostic: null };
    this.db.prepare('INSERT OR IGNORE INTO notification_delivery VALUES (?,?,?,?,?,?,?)')
      .run(id, record.notificationId, channelId, record.state, now, JSON.stringify(record), JSON.stringify(content));
    return record;
  }
  createTest(id: string, version: number, now: string): NotificationDelivery {
    return this.transaction(() => {
      const channel = this.requireVersion(id, version);
      const number = randomUUID();
      const record = this.insertDelivery(id, version, channel.bindingGeneration, { notificationId: `test:${number}`,
        text: `Multivac 通知渠道测试，编号 ${number}。请核对手机是否收到此编号。`, scheduledAt: now,
        localTime: now.slice(0, 19), timeZone: 'UTC', createdAt: now }, 'test', now);
      this.saveChannel({ ...channel, testedDeliveryId: record.id, phoneConfirmedAt: null });
      return record;
    });
  }
  confirmTest(id: string, version: number, deliveryId: string, now: string): NotificationChannel {
    return this.transaction(() => {
      const channel = this.requireVersion(id, version), test = this.delivery(deliveryId);
      if (!test || test.channelId !== id || test.kind !== 'test' || channel.testedDeliveryId !== deliveryId ||
        test.bindingGeneration !== channel.bindingGeneration || test.state !== 'accepted') {
        throw new TaskServiceError('TASK_CONFLICT', '请核对当前绑定的测试编号及接口接受结果。');
      }
      const next = { ...channel, phoneConfirmedAt: now };
      this.saveChannel(next); return next;
    });
  }
  private cancelQueued(id: string, now: string, diagnostic: string): void {
    for (const row of this.db.prepare("SELECT record_json FROM notification_delivery WHERE channel_id=? AND state IN ('pending','waiting')").all(id)) {
      const record = JSON.parse(String(row.record_json)) as NotificationDelivery;
      this.saveDelivery({ ...record, state: 'cancelled', completedAt: now, diagnostic });
    }
  }
  /** 提交后补查和持续对账共用此入口；区间进度与队列插入一起提交。 */
  reconcile(now: string): number {
    return this.transaction(() => {
      let inserted = 0;
      for (const range of this.db.prepare('SELECT * FROM notification_channel_range WHERE end_seq IS NULL OR scanned_seq<end_seq ORDER BY id').all()) {
        const rows = this.db.prepare('SELECT rowid AS seq,record_json FROM inbox_notification WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 100')
          .all(range.scanned_seq!, range.end_seq ?? this.lastSequence());
        for (const row of rows) {
          const notification = JSON.parse(String(row.record_json)) as InboxNotification;
          // 来源只能是持久提醒通知；身份同时核对，不能把其他 Inbox 事项转换为通知。
          if (notification.id !== `notification:${notification.reminderId}:${notification.reminderRevision}`) continue;
          const before = this.db.prepare('SELECT id FROM notification_delivery WHERE notification_id=? AND channel_id=?').get(notification.id, range.channel_id!);
          if (!before) {
            const record = this.insertDelivery(String(range.channel_id), Number(range.config_version), Number(range.binding_generation), {
              notificationId: notification.id, text: notification.text, scheduledAt: notification.scheduledAt,
              localTime: notification.localTime, timeZone: notification.timeZone, createdAt: notification.createdAt,
            }, 'notification', now);
            this.validateQueued(record, now); inserted++;
          }
        }
        if (rows.length) this.db.prepare('UPDATE notification_channel_range SET scanned_seq=? WHERE id=?').run(rows.at(-1)!.seq!, range.id!);
      }
      for (const row of this.db.prepare("SELECT record_json FROM notification_delivery WHERE state IN ('pending','waiting')").all()) {
        this.validateQueued(JSON.parse(String(row.record_json)), now);
      }
      return inserted;
    });
  }
  /** 发送前同样调用；查看和 seen 不参与取消判断。 */
  validateQueued(record: NotificationDelivery, now: string): boolean {
    if (!queued.has(record.state)) return false;
    const channel = this.channel(record.channelId);
    const row = record.notificationId ? this.db.prepare('SELECT record_json FROM inbox_notification WHERE id=?').get(record.notificationId) : null;
    const notification = row ? JSON.parse(String(row.record_json)) as InboxNotification : null;
    let state: 'cancelled' | 'expired' | null = null;
    if (!channel || channel.bindingGeneration !== record.bindingGeneration || channel.version !== record.configVersion ||
      (record.kind === 'notification' && (!channel.enabled || !notification || notification.acknowledgedAt))) state = 'cancelled';
    else if (record.expiresAt <= now) state = 'expired';
    if (state) { this.saveDelivery({ ...record, state, completedAt: now, diagnostic: state === 'expired' ? '已超过24小时外发期限，原通知保留在 Inbox。' : '配置或原通知已变化，未开始的投递已取消。' }); return false; }
    return true;
  }
}
