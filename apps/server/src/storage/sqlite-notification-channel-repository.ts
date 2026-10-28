import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InboxNotification, NotificationChannel, NotificationContent, NotificationDelivery, NotificationChannelOperation } from '@multivac/contracts';
import { NOTIFICATION_DELIVERY_TTL_MS } from '@multivac/contracts';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import type { ChannelSendResult } from '../modules/notifications/channel.js';
import type { NotificationChannelRepository } from '../modules/notifications/repository.js';
import { runInTransaction } from './sqlite-transaction.js';

const queued = new Set(['pending', 'waiting']);

/**
 * 只处理提醒通知表，显式排除澄清、目录授权、外发授权、成果验收、恢复确认和MCP调用授权。
 * 不从通用Inbox列表分发，防止后续加入的决定事项获得外发或业务权限。
 */
export class SqliteNotificationChannelRepository implements NotificationChannelRepository {
  private transactionDepth = 0;
  constructor(private readonly db: DatabaseSync) {}
  /** 同仓储命令入口复用当前短同步事务，使事实与回执一起保存。 */
  transaction<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    return runInTransaction(this.db, () => {
      this.transactionDepth++;
      try { return operation(); } finally { this.transactionDepth--; }
    });
  }
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
  beginOperation(id: string, fingerprint: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT fingerprint FROM notification_channel_command WHERE id=?').get(id);
      if (row) {
        if (row.fingerprint !== `operation:${fingerprint}`) throw new TaskServiceError('COMMAND_ID_CONFLICT', '通知渠道命令内容已变化。');
        return false;
      }
      this.db.prepare('INSERT INTO notification_channel_command VALUES (?,?,?)').run(id, `operation:${fingerprint}`, JSON.stringify({ state: 'running' }));
      return true;
    });
  }
  operation(id: string): NotificationChannelOperation {
    const row = this.db.prepare('SELECT fingerprint,result_json FROM notification_channel_command WHERE id=?').get(id);
    if (!row) throw new TaskServiceError('NOT_FOUND', '操作记录尚不存在，请稍后只读核对。');
    return String(row.fingerprint).startsWith('operation:') ? JSON.parse(String(row.result_json)) : { state: 'done' };
  }
  finishOperation(id: string, state: 'done' | 'unknown'): void {
    this.db.prepare("UPDATE notification_channel_command SET result_json=? WHERE id=? AND fingerprint LIKE 'operation:%'").run(JSON.stringify({ state }), id);
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
      readiness: 'waiting', diagnostic: null, testedDeliveryId: null, receivedConfirmedAt: null };
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
      if (enabled && (!current.receivedConfirmedAt || current.readiness !== 'ready')) {
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
        enabled: false, readiness: 'waiting', diagnostic: null, testedDeliveryId: null, receivedConfirmedAt: null };
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
      if (channel.enabled) throw new TaskServiceError('TASK_CONFLICT', '请先暂停正式通知，再发送新的编号测试。');
      const number = randomUUID();
      const record = this.insertDelivery(id, version, channel.bindingGeneration, { notificationId: `test:${number}`,
        text: `Multivac 通知渠道测试，编号 ${number}。请核对手机是否收到此编号。`, scheduledAt: now,
        localTime: now.slice(0, 19), timeZone: 'UTC', createdAt: now }, 'test', now);
      this.db.prepare('UPDATE notification_delivery SET content_json=? WHERE id=?').run(JSON.stringify({
        ...this.content(record.id), text: `Multivac 通知渠道测试，编号 ${record.localMessageId}。请在 Multivac 核对手机是否收到此编号。`,
      }), record.id);
      this.saveChannel({ ...channel, testedDeliveryId: record.id, receivedConfirmedAt: null });
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
      const next = { ...channel, receivedConfirmedAt: now };
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
  /** 仅在已确认同库旧服务停止后的启动恢复调用，不把遗留发送中退回待发送。 */
  recover(now: string): void {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT record_json FROM notification_delivery WHERE state='sending'").all()) {
        const record = JSON.parse(String(row.record_json)) as NotificationDelivery;
        const result: ChannelSendResult = { outcome: 'unknown', diagnostic: '上次发送未保留完整结果，需核对；不会自动重发。' };
        this.saveDelivery({ ...record, state: 'unknown', completedAt: now, diagnostic: result.diagnostic });
        this.db.prepare('UPDATE notification_delivery_attempt SET result_json=? WHERE delivery_id=? AND attempt=? AND result_json IS NULL')
          .run(JSON.stringify(result), record.id, record.attempts);
      }
      this.db.prepare('UPDATE notification_channel SET owner=NULL').run();
      this.db.prepare("UPDATE notification_channel_command SET result_json=? WHERE fingerprint LIKE 'operation:%' AND json_extract(result_json,'$.state')='running'")
        .run(JSON.stringify({ state: 'unknown' }));
    });
  }
  acquire(id: string, owner: string, now: string): NotificationDelivery | null {
    return this.transaction(() => {
      const lock = this.db.prepare("UPDATE notification_channel SET owner=? WHERE id=? AND owner IS NULL AND NOT EXISTS (SELECT 1 FROM notification_delivery WHERE channel_id=? AND state='sending')").run(owner, id, id);
      if (!lock.changes) return null;
      const row = this.db.prepare("SELECT record_json FROM notification_delivery WHERE channel_id=? AND state IN ('pending','waiting') AND next_attempt_at<=? ORDER BY rowid LIMIT 1").get(id, now);
      const record = row ? JSON.parse(String(row.record_json)) as NotificationDelivery : null;
      if (record && this.validateQueued(record, now)) return record;
      this.release(id, owner); return null;
    });
  }
  release(id: string, owner: string): void {
    this.db.prepare('UPDATE notification_channel SET owner=NULL WHERE id=? AND owner=?').run(id, owner);
  }
  private owned(id: string, owner: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM notification_channel WHERE id=? AND owner=?').get(id, owner);
  }
  wait(id: string, owner: string, now: string, diagnostic: string): void {
    const record = this.delivery(id);
    if (!record || !this.owned(record.channelId, owner) || !this.validateQueued(record, now)) return;
    this.saveDelivery({ ...record, state: 'waiting', nextAttemptAt: new Date(Date.parse(now) + 30_000).toISOString(), diagnostic });
  }
  beginSend(id: string, owner: string, now: string): NotificationDelivery | null {
    return this.transaction(() => {
      const record = this.delivery(id);
      if (!record || !this.owned(record.channelId, owner) || !this.validateQueued(record, now)) return null;
      if (record.attempts >= 5) {
        this.saveDelivery({ ...record, state: 'failed', completedAt: now, diagnostic: '确定未发出后的重试已达上限。' }); return null;
      }
      const next: NotificationDelivery = { ...record, state: 'sending', startedAt: now, attempts: record.attempts + 1, diagnostic: null };
      this.saveDelivery(next);
      this.db.prepare('INSERT INTO notification_delivery_attempt VALUES (?,?,?,NULL)').run(next.id, next.attempts, now);
      return next;
    });
  }
  finish(sent: NotificationDelivery, owner: string, result: ChannelSendResult, now: string): void {
    this.transaction(() => {
      const record = this.delivery(sent.id);
      if (!record || !this.owned(sent.channelId, owner) || record.state !== 'sending' || record.attempts !== sent.attempts) return;
      let state: NotificationDelivery['state'] = 'unknown';
      if (result.outcome === 'accepted') state = 'accepted';
      else if (result.outcome === 'rejected') state = 'failed';
      else if (result.outcome === 'not-sent') state = record.expiresAt <= now ? 'expired' : record.attempts >= 5 ? 'failed' : 'pending';
      const retryAt = new Date(Date.parse(now) + Math.min(60_000, 1000 * 2 ** record.attempts)).toISOString();
      this.saveDelivery({ ...record, state, serverMessageId: result.outcome === 'accepted' ? result.serverMessageId : null,
        diagnostic: result.outcome === 'accepted' ? null : result.diagnostic,
        completedAt: state === 'pending' ? null : now, nextAttemptAt: state === 'pending' ? retryAt : record.nextAttemptAt });
      this.db.prepare('UPDATE notification_delivery_attempt SET result_json=? WHERE delivery_id=? AND attempt=?')
        .run(JSON.stringify(result), sent.id, sent.attempts);
      const channel = this.channel(sent.channelId);
      if (result.outcome === 'rejected' && result.credentialsInvalid && channel?.bindingGeneration === sent.bindingGeneration && channel.version === sent.configVersion) {
        this.setReadiness(channel.id, 'invalid', '渠道凭据已失效，请重新绑定；原通知保留在 Inbox。');
      }
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
