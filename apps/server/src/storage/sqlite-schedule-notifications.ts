import { reminderSchedule } from '../modules/schedules/legacy-reminder.js';
import type { DatabaseSync } from 'node:sqlite';
import type { InboxNotification, Reminder, Schedule, ScheduleOccurrence } from '@multivac/contracts';
import { SqliteScheduleRepository } from './sqlite-schedule-repository.js';
import { makeOccurrence } from '../application/schedule-service.js';
import { scheduledOccurrenceId } from '../application/schedule-scheduler.js';

/** 与统一仓储共享连接的明确事务入口。旧回执/通知保留原表，旧计时器一次性退出消费。 */
export class SqliteScheduleNotifications {
  constructor(private readonly db: DatabaseSync, private readonly schedules: SqliteScheduleRepository) {}
  migrate(): void {
    this.schedules.transaction(() => {
      for (const row of this.db.prepare('SELECT record_json FROM reminder').all()) {
        const reminder = JSON.parse(String(row.record_json)) as Reminder;
        if (this.schedules.get(reminder.reminderId)) continue;
        const schedule = reminderSchedule(reminder); this.schedules.save(schedule);
        if (reminder.status !== 'scheduled') {
          const occurrence = makeOccurrence(schedule, scheduledOccurrenceId(schedule.scheduleId, reminder.scheduledAt), reminder.scheduledAt, 'planned');
          this.schedules.saveOccurrence({ ...occurrence, status: reminder.status === 'delivered' ? 'succeeded' : reminder.status === 'failed' ? 'failed' : 'skipped',
            notificationId: reminder.notificationId, reason: reminder.failure ?? (reminder.status === 'cancelled' ? '旧提醒已取消。' : null), endedAt: reminder.updatedAt });
        }
      }
      this.db.prepare("UPDATE reminder_timer SET state='cancelled',leaseUntil=NULL WHERE state IN ('pending','claimed')").run();
    });
  }
  /** 通知与动作完成原子提交；外发始终由原渠道账本单独去重。 */
  deliver(item: ScheduleOccurrence, now: string, text?: string): InboxNotification {
    return this.schedules.transaction(() => {
      const current = this.schedules.occurrence(item.occurrenceId);
      if (!current || current.leaseOwner !== item.leaseOwner || !['running', 'waiting', 'stopping', 'reconcile'].includes(current.status)) throw new Error('本次通知执行归属已变化。');
      const schedule = item.snapshot;
      const legacy = schedule.legacyReminderId && item.source === 'planned';
      const id = legacy ? `notification:${schedule.legacyReminderId}:${schedule.revision}` : `notification:${item.occurrenceId}`;
      const notification: InboxNotification = { id, revision: 1, reminderId: legacy ? schedule.legacyReminderId : null,
        reminderRevision: legacy ? schedule.revision : null, source: schedule.action.kind, scheduleId: schedule.scheduleId, occurrenceId: item.occurrenceId,
        text: text ?? (schedule.action.kind === 'reminder' ? schedule.action.text : 'Agent 执行已结束。'), scheduledAt: item.plannedAt,
        localTime: item.localTime, timeZone: schedule.timeZone, sourceSessionId: current.sessionId ?? schedule.sourceSessionId, createdAt: now, acknowledgedAt: null };
      this.db.prepare('INSERT OR IGNORE INTO inbox_notification VALUES (?,?)').run(id, JSON.stringify(notification));
      // Agent 的实际终态由执行器结算；提醒不涉及模型，通知落库即完成。
      this.schedules.saveOccurrence({ ...current, notificationId: id, ...(schedule.action.kind === 'reminder' ? { status: 'succeeded' as const, endedAt: now, leaseUntil: null, summary: 'Inbox 提醒已送达。' } : {}) });
      if (legacy) {
        const row = this.db.prepare('SELECT record_json FROM reminder WHERE id=?').get(schedule.legacyReminderId!);
        if (row) {
          const reminder = JSON.parse(String(row.record_json)) as Reminder;
          if (reminder.revision === schedule.revision) {
            const next = { ...reminder, status: 'delivered', notificationId: id, updatedAt: now };
            this.db.prepare("UPDATE reminder SET status='delivered',record_json=? WHERE id=?").run(JSON.stringify(next), reminder.reminderId);
          }
        }
      }
      const row = this.db.prepare('SELECT record_json FROM inbox_notification WHERE id=?').get(id)!;
      return JSON.parse(String(row.record_json)) as InboxNotification;
    });
  }
}
