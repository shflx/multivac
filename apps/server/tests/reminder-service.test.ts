import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ReminderService } from '../src/application/reminder-service.js';
import { REMINDER_MIGRATION, SqliteReminderRepository } from '../src/storage/sqlite-reminder-repository.js';
import { createReminderTool, reminderContextTool, reconcileReminderTool } from '../src/application/internal-tools/reminder-tools.js';
import type { InternalToolProposeContext } from '../src/application/internal-tools/internal-tool-service.js';

const input = { commandId: 'meeting-command', text: '开会', scheduledAt: '2026-10-14T15:00:00+08:00', timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00' };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION);
  const repository = new SqliteReminderRepository(db);
  let now = new Date('2026-10-14T00:00:00Z');
  const service = new ReminderService(repository, id => assert.equal(id, 'global-coordinator'), () => now);
  return { db, repository, service, clock: (date: string) => { now = new Date(date); } };
}

test('原命令重复与响应丢失只读对账，时间经过后仍能读原回执', () => {
  const { db, service, clock } = fixture();
  try {
    const saved = service.create('global-coordinator', input);
    clock('2026-10-15T00:00:00Z');
    assert.deepEqual(service.create('global-coordinator', input), saved);
    assert.equal(service.page().total, 1);
    assert.equal(service.reconcile('global-coordinator', input.commandId).result!.reminderId, saved.reminderId);
    assert.equal(service.reconcile('global-coordinator', 'missing').saved, false);
    assert.throws(() => service.create('global-coordinator', { ...input, text: '其他内容' }), /原命令/);
  } finally { db.close(); }
});

test('迁移重放保留提醒、定时触发、通知与原命令回执', () => {
  const { db, service, repository } = fixture();
  try {
    const saved = service.create('global-coordinator', input);
    const dueAt = '2026-10-14T07:00:00.000Z';
    const triggerId = repository.due(dueAt)[0]!;
    const notification = repository.deliver(repository.claim(triggerId, dueAt)!, dueAt);
    assert.ok(notification);
    const delivered = service.get(saved.reminderId);
    const timer = repository.timer(triggerId);
    const receipt = service.reconcile('global-coordinator', input.commandId);
    db.exec(REMINDER_MIGRATION);
    assert.deepEqual(service.get(saved.reminderId), delivered);
    assert.deepEqual(repository.timer(triggerId), timer);
    assert.deepEqual(repository.notification(notification.id), notification);
    assert.deepEqual(service.reconcile('global-coordinator', input.commandId), receipt);
  } finally { db.close(); }
});

test('修改取消要求最新版本；旧时间不触发且终态不允许修改', () => {
  const { db, service, repository } = fixture();
  try {
    const saved = service.create('global-coordinator', input);
    const changed = service.update('global-coordinator', { ...input, commandId: 'change', reminderId: saved.reminderId, revision: 1,
      scheduledAt: '2026-10-14T16:00:00+08:00', localTime: '2026-10-14T16:00:00' });
    assert.equal(changed.revision, 2);
    assert.deepEqual(repository.due('2026-10-14T07:00:00.000Z'), []);
    assert.throws(() => service.cancel('global-coordinator', { commandId: 'stale', reminderId: saved.reminderId, revision: 1 }), /版本/);
    const cancel = { commandId: 'cancel', reminderId: saved.reminderId, revision: 2 };
    assert.equal(service.cancel('global-coordinator', cancel).status, 'cancelled');
    assert.equal(service.cancel('global-coordinator', cancel).status, 'cancelled');
    assert.deepEqual(repository.due('2026-10-14T09:00:00.000Z'), []);
    assert.throws(() => service.update('global-coordinator', { ...input, commandId: 'after-cancel', reminderId: saved.reminderId, revision: 3 }), /不能修改/);
  } finally { db.close(); }
});

test('保存失败没有成功回执；过去时间与空文本不静默接受', () => {
  const { db, service } = fixture();
  try {
    db.exec("CREATE TRIGGER fail_save BEFORE INSERT ON reminder_timer BEGIN SELECT RAISE(ABORT,'save failure'); END;");
    assert.throws(() => service.create('global-coordinator', input));
    assert.equal(service.reconcile('global-coordinator', input.commandId).saved, false);
    assert.equal(service.page().total, 0);
    db.exec('DROP TRIGGER fail_save');
    assert.throws(() => service.create('global-coordinator', { ...input, scheduledAt: '2026-10-14T08:00:00+08:00', localTime: '2026-10-14T08:00:00' }), /已经过去/);
    assert.throws(() => service.create('global-coordinator', { ...input, text: '  ' }), /不能为空/);
    assert.equal(service.page().total, 0);
  } finally { db.close(); }
});

test('内部工具读取浏览器时区、真实保存与原命令对账；错误不报告成功', async () => {
  const { db, service } = fixture();
  const context = { sessionId: 'global-coordinator', services: { reminders: service }, originView: { timeZone: 'Asia/Shanghai' } } as unknown as InternalToolProposeContext;
  try {
    const clock = await reminderContextTool.execute({}, context);
    assert.equal(JSON.parse(clock.content).timeZone, 'Asia/Shanghai');
    const outcome = await createReminderTool.execute(input, context);
    assert.match(outcome.content, /已持久化/);
    const receipt = await reconcileReminderTool.execute({ commandId: input.commandId }, context);
    assert.match(receipt.content, /"saved":true/);
    assert.equal(service.page().total, 1);
    await assert.rejects(createReminderTool.execute({ ...input, commandId: 'invalid', timeZone: 'bad' }, context), /时区/);
    assert.equal(service.page().total, 1);
    assert.equal(service.context().timeZone, null);
    const unknownContext = { ...context, services: { reminders: {
      create: service.create.bind(service), get: () => { throw new Error('回执读取失败'); },
    } } } as unknown as InternalToolProposeContext;
    await assert.rejects(createReminderTool.execute({ ...input, commandId: 'lost-receipt' }, unknownContext), /reconcile_reminder_command.*lost-receipt/);
    assert.equal(service.reconcile('global-coordinator', 'lost-receipt').saved, true);
  } finally { db.close(); }
});
