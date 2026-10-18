import type { DatabaseSync } from 'node:sqlite';
import type { Reminder, ReminderTimer, InboxNotification, ReminderQuery } from '@multivac/contracts';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import type { ReminderRepository } from '../modules/tasks/reminder.js';
import { runInTransaction } from './sqlite-transaction.js';

export const REMINDER_MIGRATION = `
  CREATE TABLE IF NOT EXISTS reminder (id TEXT PRIMARY KEY, status TEXT NOT NULL, scheduled_at TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS reminder_schedule_idx ON reminder(status, scheduled_at, id);
  CREATE TABLE IF NOT EXISTS reminder_timer (
    triggerId TEXT PRIMARY KEY, reminderId TEXT NOT NULL, reminderRevision INTEGER NOT NULL,
    handler TEXT NOT NULL CHECK(handler='inbox-notification'), dueAt TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL, availableAt TEXT NOT NULL,
    leaseUntil TEXT, lastError TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS reminder_timer_due_idx ON reminder_timer(state, availableAt, leaseUntil);
  CREATE TABLE IF NOT EXISTS inbox_notification (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS reminder_command (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;
export const REMINDER_MAX_ATTEMPTS = 5;

/** 短同步事务内保存事实与回执；不包含模型、网络或文件操作。 */
export class SqliteReminderRepository implements ReminderRepository {
  constructor(private readonly db: DatabaseSync) {}
  transaction<T>(operation: () => T): T { return runInTransaction(this.db, operation); }
  receipt<T>(commandId: string): { fingerprint: string; result: T } | null {
    const row = this.db.prepare('SELECT fingerprint,result_json FROM reminder_command WHERE command_id=?').get(commandId);
    return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result_json)) as T } : null;
  }
  command<T>(commandId: string, key: string, operation: () => T): T {
    return this.transaction(() => {
      const previous = this.receipt<T>(commandId);
      if (previous) {
        if (previous.fingerprint !== key) throw new TaskServiceError('COMMAND_ID_CONFLICT', '原命令与当前输入不同，请核对原安排。');
        return previous.result;
      }
      const result = operation();
      this.db.prepare('INSERT INTO reminder_command VALUES (?,?,?)').run(commandId, key, JSON.stringify(result));
      return result;
    });
  }
  get(id: string): Reminder | null {
    const row = this.db.prepare('SELECT record_json FROM reminder WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as Reminder : null;
  }
  save(reminder: Reminder): void {
    this.db.prepare('INSERT INTO reminder VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,scheduled_at=excluded.scheduled_at,record_json=excluded.record_json')
      .run(reminder.reminderId, reminder.status, reminder.scheduledAt, JSON.stringify(reminder));
  }
  page(query: ReminderQuery = {}) {
    const where = query.status ? 'WHERE status=?' : '';
    const args = query.status ? [query.status] : [];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS total FROM reminder ${where}`).get(...args)!.total);
    const offset = query.offset ?? 0;
    const items = this.db.prepare(`SELECT record_json FROM reminder ${where} ORDER BY scheduled_at,id LIMIT ? OFFSET ?`).all(...args, query.limit ?? 20, offset)
      .map(row => JSON.parse(String(row.record_json)) as Reminder);
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  schedule(reminder: Reminder): void {
    this.invalidate(reminder.reminderId);
    const triggerId = `notification:${reminder.reminderId}:${reminder.revision}`;
    this.db.prepare("INSERT INTO reminder_timer VALUES (?,?,?,'inbox-notification',?,'pending',0,?,NULL,NULL)")
      .run(triggerId, reminder.reminderId, reminder.revision, reminder.scheduledAt, reminder.scheduledAt);
  }
  invalidate(id: string): void {
    this.db.prepare("UPDATE reminder_timer SET state='cancelled',leaseUntil=NULL WHERE reminderId=? AND state IN ('pending','claimed')").run(id);
  }
  timer(id: string): ReminderTimer | null {
    const row = this.db.prepare('SELECT * FROM reminder_timer WHERE triggerId=?').get(id);
    return row ? row as unknown as ReminderTimer : null;
  }
  due(now: string, limit = 100): string[] {
    return this.db.prepare("SELECT triggerId FROM reminder_timer WHERE (state='pending' AND availableAt<=?) OR (state='claimed' AND leaseUntil<=?) ORDER BY availableAt,triggerId LIMIT ?")
      .all(now, now, limit).map(row => String(row.triggerId));
  }
  claim(id: string, now: string): ReminderTimer | null {
    return this.transaction(() => {
      const item = this.timer(id);
      if (!item || !(item.state === 'pending' && item.availableAt <= now || item.state === 'claimed' && item.leaseUntil! <= now)) return null;
      const reminder = this.get(item.reminderId);
      if (!reminder || reminder.status !== 'scheduled' || reminder.revision !== item.reminderRevision) {
        this.db.prepare("UPDATE reminder_timer SET state='cancelled',leaseUntil=NULL WHERE triggerId=?").run(id); return null;
      }
      if (item.attempts >= REMINDER_MAX_ATTEMPTS) { this.failRecord(item, reminder, now, '重启或执行失败达到重试上限。'); return null; }
      this.db.prepare("UPDATE reminder_timer SET state='claimed',attempts=attempts+1,leaseUntil=? WHERE triggerId=?")
        .run(new Date(Date.parse(now) + 30_000).toISOString(), id);
      return this.timer(id);
    });
  }
  /** 插入通知与标记触发完成原子提交，失败回滚；唯一触发身份保证补发不会重复。 */
  deliver(claim: ReminderTimer, now: string): InboxNotification | null {
    return this.transaction(() => {
      const current = this.timer(claim.triggerId);
      const reminder = this.get(claim.reminderId);
      if (!current || current.state !== 'claimed' || current.attempts !== claim.attempts || !reminder || reminder.status !== 'scheduled' || reminder.revision !== claim.reminderRevision) return null;
      if (current.handler !== 'inbox-notification') throw new Error('未注册的定时处理器。');
      const notification: InboxNotification = {
        id: claim.triggerId, reminderId: reminder.reminderId, reminderRevision: reminder.revision, revision: 1,
        text: reminder.text, scheduledAt: reminder.scheduledAt, timeZone: reminder.timeZone, localTime: reminder.localTime,
        sourceSessionId: reminder.sourceSessionId, createdAt: now, acknowledgedAt: null,
      };
      this.db.prepare('INSERT OR IGNORE INTO inbox_notification VALUES (?,?)').run(notification.id, JSON.stringify(notification));
      this.save({ ...reminder, status: 'delivered', notificationId: notification.id, updatedAt: now });
      this.db.prepare("UPDATE reminder_timer SET state='done',leaseUntil=NULL,lastError=NULL WHERE triggerId=?").run(claim.triggerId);
      return this.notification(notification.id);
    });
  }
  retry(claim: ReminderTimer, now: string): void {
    this.transaction(() => {
      const current = this.timer(claim.triggerId);
      const reminder = this.get(claim.reminderId);
      if (!current || current.state !== 'claimed' || current.attempts !== claim.attempts || !reminder || reminder.status !== 'scheduled' || reminder.revision !== claim.reminderRevision) return;
      // 错误记录只保存固定说明，避免 SQLite 错误泄露内容或路径。
      const reason = '通知落库失败，请核对服务端存储。';
      if (current.attempts >= REMINDER_MAX_ATTEMPTS) this.failRecord(current, reminder, now, reason);
      else this.db.prepare("UPDATE reminder_timer SET state='pending',availableAt=?,leaseUntil=NULL,lastError=? WHERE triggerId=?")
        .run(new Date(Date.parse(now) + Math.min(60_000, 1000 * 2 ** current.attempts)).toISOString(), reason, claim.triggerId);
    });
  }
  private failRecord(timer: ReminderTimer, reminder: Reminder, now: string, reason: string): void {
    this.db.prepare("UPDATE reminder_timer SET state='failed',leaseUntil=NULL,lastError=? WHERE triggerId=?").run(reason, timer.triggerId);
    this.save({ ...reminder, status: 'failed', failure: reason, updatedAt: now });
  }
  notifications(): InboxNotification[] {
    return this.db.prepare('SELECT record_json FROM inbox_notification ORDER BY id').all().map(row => JSON.parse(String(row.record_json)) as InboxNotification);
  }
  notification(id: string): InboxNotification | null {
    const row = this.db.prepare('SELECT record_json FROM inbox_notification WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as InboxNotification : null;
  }
  acknowledge(id: string, revision: number, commandId: string, key: string, now: string): InboxNotification {
    return this.command(commandId, key, () => {
      const current = this.notification(id);
      if (!current) throw new TaskServiceError('NOT_FOUND', '通知不存在。');
      if (current.revision !== revision) throw new TaskServiceError('TASK_CONFLICT', '通知版本已变化，请读取最新通知。');
      if (current.acknowledgedAt) return current;
      const next = { ...current, revision: current.revision + 1, acknowledgedAt: now };
      this.db.prepare('UPDATE inbox_notification SET record_json=? WHERE id=?').run(JSON.stringify(next), id);
      return next;
    });
  }
}
