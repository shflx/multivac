import { createHash, randomUUID } from 'node:crypto';
import { Check } from 'typebox/value';
import { CreateReminderSchema, UpdateReminderSchema, CancelReminderSchema, ReminderQuerySchema, normalizeReminderTime, reminderLocalTime,
  type CreateReminder, type UpdateReminder, type CancelReminder, type ReminderQuery, type Reminder } from '@multivac/contracts';
import type { ReminderRepository } from '../modules/tasks/reminder.js';
import { fingerprint } from './task-service.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';

/** 用户明确安排的单次提醒，不与 Task 或执行生命周期关联。 */
export class ReminderService {
  constructor(private readonly repository: ReminderRepository, private readonly requireSession: (id: string) => void,
    private readonly now: () => Date = () => new Date()) {}
  context(timeZone?: string) {
    const now = this.now();
    let localTime: string | null = null;
    if (timeZone) {
      try { localTime = reminderLocalTime(now, timeZone); }
      catch { throw new TaskServiceError('INVALID_REQUEST', '用户时区无效，请核对 IANA 时区。'); }
    }
    return { currentTime: now.toISOString(), timeZone: timeZone ?? null, localTime,
      limitation: '仅支持单次 Inbox 提醒。服务关闭期间无法准时通知，重启后补发并显示原计划时间。' };
  }
  get(id: string): Reminder {
    const item = this.repository.get(id);
    if (!item) throw new TaskServiceError('NOT_FOUND', '提醒不存在，请按稳定 ID 查询，不猜同名提醒。');
    return item;
  }
  page(query: ReminderQuery = {}) {
    if (!Check(ReminderQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '提醒查询参数无效。');
    return this.repository.page(query);
  }
  reconcile(sessionId: string, commandId: string) {
    this.requireSession(sessionId);
    const receipt = this.repository.receipt<Reminder>(this.commandKey(sessionId, commandId));
    return { commandId, saved: Boolean(receipt), result: receipt?.result ?? null,
      current: receipt ? this.repository.get(receipt.result.reminderId) : null };
  }
  create(sessionId: string, input: CreateReminder): Reminder {
    if (!Check(CreateReminderSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '创建提醒参数无效。');
    this.requireSession(sessionId);
    return this.repository.command(this.commandKey(sessionId, input.commandId), fingerprint({ sessionId, kind: 'create', ...input }), () => {
      const scheduledAt = this.time(input);
      const now = this.now().toISOString();
      const reminder: Reminder = { reminderId: randomUUID(), revision: 1, text: input.text.trim(), scheduledAt,
        timeZone: input.timeZone, localTime: input.localTime, sourceSessionId: sessionId, status: 'scheduled',
        createdAt: now, updatedAt: now, notificationId: null, failure: null };
      this.repository.save(reminder); this.repository.schedule(reminder);
      return reminder;
    });
  }
  update(sessionId: string, input: UpdateReminder): Reminder {
    if (!Check(UpdateReminderSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '修改提醒参数无效。');
    this.requireSession(sessionId);
    return this.repository.command(this.commandKey(sessionId, input.commandId), fingerprint({ sessionId, kind: 'update', ...input }), () => {
      const current = this.scheduled(input.reminderId, input.revision);
      const scheduledAt = this.time(input);
      const next = { ...current, revision: current.revision + 1, text: input.text.trim(), scheduledAt,
        timeZone: input.timeZone, localTime: input.localTime, updatedAt: this.now().toISOString() };
      this.repository.save(next); this.repository.schedule(next);
      return next;
    });
  }
  cancel(sessionId: string, input: CancelReminder): Reminder {
    if (!Check(CancelReminderSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '取消提醒参数无效。');
    this.requireSession(sessionId);
    return this.repository.command(this.commandKey(sessionId, input.commandId), fingerprint({ sessionId, kind: 'cancel', ...input }), () => {
      const current = this.scheduled(input.reminderId, input.revision);
      const next: Reminder = { ...current, revision: current.revision + 1, status: 'cancelled', updatedAt: this.now().toISOString() };
      this.repository.save(next); this.repository.invalidate(next.reminderId);
      return next;
    });
  }
  private scheduled(id: string, revision: number): Reminder {
    const current = this.get(id);
    if (current.revision !== revision) throw new TaskServiceError('TASK_CONFLICT', '提醒版本已变化，请查询最新版本后再操作。');
    if (current.status !== 'scheduled') throw new TaskServiceError('INVALID_REQUEST', '提醒已经触发、取消或失败，不能修改旧安排。');
    return current;
  }
  private time(input: CreateReminder): string {
    if (!input.text.trim()) throw new TaskServiceError('INVALID_REQUEST', '提醒文本不能为空。');
    try { return normalizeReminderTime(input, this.now()); }
    catch (error) { throw new TaskServiceError('INVALID_REQUEST', error instanceof Error ? error.message : '计划时间无效。'); }
  }
  private commandKey(sessionId: string, commandId: string): string {
    return `reminder:${createHash('sha256').update(JSON.stringify([sessionId, commandId])).digest('hex')}`;
  }
}
