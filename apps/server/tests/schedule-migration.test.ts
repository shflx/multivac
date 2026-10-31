import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { REMINDER_MIGRATION, SqliteReminderRepository } from '../src/storage/sqlite-reminder-repository.js';
import { SCHEDULE_MIGRATION, SqliteScheduleRepository } from '../src/storage/sqlite-schedule-repository.js';
import { SqliteScheduleNotifications } from '../src/storage/sqlite-schedule-notifications.js';
import { ReminderService } from '../src/application/reminder-service.js';
import { ScheduleScheduler } from '../src/application/schedule-scheduler.js';
import { ScheduleService } from '../src/application/schedule-service.js';

test('旧状态与 claimed 安全迁移，重复迁移与重启不重复通知，旧命令回执保留', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION + SCHEDULE_MIGRATION);
  const reminders = new SqliteReminderRepository(db), schedules = new SqliteScheduleRepository(db);
  const before = new Date('2026-01-01Z'), after = new Date('2026-01-03Z');
  const old = new ReminderService(reminders, () => {}, () => before);
  const input = { commandId: 'create', text: '喝水', scheduledAt: '2026-01-02T09:00:00Z', localTime: '2026-01-02T09:00:00', timeZone: 'UTC' };
  const item = old.create('session', input);
  reminders.claim(`notification:${item.reminderId}:1`, after.toISOString());
  for (const status of ['delivered', 'cancelled', 'failed'] as const) reminders.save({ ...item, reminderId: status, status });
  const notifications = new SqliteScheduleNotifications(db, schedules); notifications.migrate(); notifications.migrate();
  assert.equal(schedules.page({ state: 'deleted' }).total, 1);
  assert.equal(schedules.page({ state: 'completed' }).total, 2);
  assert.equal(reminders.due(after.toISOString()).length, 0);
  const unified = new ReminderService(reminders, () => {}, () => after, schedules);
  assert.deepEqual(unified.create('session', input), item);
  const scheduler = new ScheduleScheduler(schedules, {
    run: async occurrence => { const notification = notifications.deliver(occurrence, after.toISOString()); return { status: 'succeeded', summary: '送达', notificationId: notification.id }; }, stop: async () => true,
  }, () => {}, () => after);
  scheduler.tick(); await scheduler.settle(); notifications.migrate(); scheduler.recover(); scheduler.tick(); await scheduler.settle();
  assert.equal(reminders.notifications().length, 1);
  assert.equal(reminders.notifications()[0]!.id, `notification:${item.reminderId}:1`);
  assert.equal(unified.get(item.reminderId).status, 'delivered'); db.close();
});
test('周期通知按 occurrence 去重，知道了不暂停，删除保留通知', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION + SCHEDULE_MIGRATION);
  const repo = new SqliteScheduleRepository(db), reminders = new SqliteReminderRepository(db), notifications = new SqliteScheduleNotifications(db, repo);
  const now = () => new Date('2026-01-01Z'); const service = new ScheduleService(repo, now);
  const item = service.create('session', { commandId: 'create', name: '喝水', action: { kind: 'reminder', text: '喝水' }, rule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC', missedPolicy: 'skip' });
  service.control('session', { commandId: 'trigger', scheduleId: item.scheduleId, revision: 1, operation: 'trigger' });
  const scheduler = new ScheduleScheduler(repo, { run: async occurrence => { const n = notifications.deliver(occurrence, now().toISOString()); return { status: 'succeeded', summary: '送达', notificationId: n.id }; }, stop: async () => true }, () => {}, now);
  scheduler.tick(); await scheduler.settle();
  const n = reminders.notifications()[0]!; assert.equal(n.reminderId, null); assert.equal(n.source, 'reminder');
  reminders.acknowledge(n.id, 1, 'ack', 'ack', now().toISOString());
  assert.equal(repo.get(item.scheduleId)!.state, 'active');
  service.control('session', { commandId: 'delete', scheduleId: item.scheduleId, revision: 1, operation: 'delete' });
  assert.equal(reminders.notifications().length, 1); db.close();
});

test('旧单次改为周期后每轮通知独立，旧接口不可覆盖新周期且原回执保留', async () => {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION + SCHEDULE_MIGRATION);
  const reminders = new SqliteReminderRepository(db), repo = new SqliteScheduleRepository(db);
  let time = new Date('2026-01-01T00:00:00Z'); const now = () => time;
  const old = new ReminderService(reminders, () => {}, now);
  const input = { commandId: 'original', text: '喝水', scheduledAt: '2026-01-02T09:00:00Z', localTime: '2026-01-02T09:00:00', timeZone: 'UTC' };
  const original = old.create('session', input);
  const notifications = new SqliteScheduleNotifications(db, repo); notifications.migrate();
  const service = new ScheduleService(repo, now), item = service.get(original.reminderId);
  service.update('session', { name: item.name, action: item.action, rule: {kind:'daily',time:'09:00'}, timeZone:'UTC', missedPolicy:'skip', scheduleId:item.scheduleId, revision:1, commandId:'convert' });
  const unified = new ReminderService(reminders, () => {}, now, repo);
  assert.equal(unified.get(original.reminderId).status,'cancelled');
  assert.throws(() => unified.cancel('session',{commandId:'old-cancel',reminderId:original.reminderId,revision:2}));
  assert.deepEqual(unified.create('session',input),original);
  const scheduler = new ScheduleScheduler(repo, { run:async occurrence => {
    const n = notifications.deliver(occurrence,now().toISOString()); return {status:'succeeded',summary:'送达',notificationId:n.id};
  },stop:async () => true },() => {},now);
  for (const at of ['2026-01-01T09:00:00Z','2026-01-02T09:00:00Z']) {time=new Date(at);scheduler.tick();await scheduler.settle();}
  assert.equal(reminders.notifications().length,2);
  assert.equal(new Set(reminders.notifications().map(n => n.id)).size,2);
  assert.ok(reminders.notifications().every(n => n.reminderId === null && n.occurrenceId));
  assert.equal(repo.get(item.scheduleId)!.rule.kind,'daily'); db.close();
});
