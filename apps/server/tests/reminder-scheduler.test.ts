import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { Reminder } from '@multivac/contracts';
import { REMINDER_MIGRATION, SqliteReminderRepository } from '../src/storage/sqlite-reminder-repository.js';
import { ReminderScheduler } from '../src/application/reminder-scheduler.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(REMINDER_MIGRATION);
  const repository = new SqliteReminderRepository(db);
  const reminder: Reminder = { reminderId: 'r1', revision: 1, text: '开会', scheduledAt: '2026-10-14T07:00:00.000Z',
    timeZone: 'Asia/Shanghai', localTime: '2026-10-14T15:00:00', sourceSessionId: 'global-coordinator', status: 'scheduled',
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', notificationId: null, failure: null };
  repository.transaction(() => { repository.save(reminder); repository.schedule(reminder); });
  return { db, repository, reminder, id: 'notification:r1:1', now: '2026-10-14T07:00:00.000Z' };
}

test('到期前不触发；重复认领及补查只生成一次，保留原计划时间', () => {
  const { db, repository, id, now } = fixture();
  try {
    assert.deepEqual(repository.due('2026-10-14T06:59:59.999Z'), []);
    const claim = repository.claim(id, now)!;
    assert.equal(repository.claim(id, now), null);
    const late = '2026-10-14T08:00:00.000Z';
    const restored = new SqliteReminderRepository(db);
    const recovered = restored.claim(id, late)!;
    assert.equal(restored.deliver(claim, late), null);
    const notification = restored.deliver(recovered, late)!;
    assert.equal(notification.scheduledAt, now);
    assert.equal(notification.createdAt, late);
    assert.equal(restored.deliver(recovered, late), null);
    assert.equal(restored.notifications().length, 1);
    assert.equal(restored.get('r1')!.status, 'delivered');
  } finally { db.close(); }
});

test('修改及取消使已认领旧版本失效', () => {
  const { db, repository, reminder, id, now } = fixture();
  try {
    const old = repository.claim(id, now)!;
    const changed = { ...reminder, revision: 2, scheduledAt: '2026-10-14T08:00:00.000Z' };
    repository.transaction(() => { repository.save(changed); repository.schedule(changed); });
    assert.equal(repository.deliver(old, now), null);
    const next = repository.claim('notification:r1:2', changed.scheduledAt)!;
    repository.transaction(() => { repository.save({ ...changed, revision: 3, status: 'cancelled' }); repository.invalidate('r1'); });
    assert.equal(repository.deliver(next, changed.scheduledAt), null);
    assert.equal(repository.notifications().length, 0);
  } finally { db.close(); }
});

test('通知插入后的故障回滚全部事实，租约恢复可再次落库', () => {
  const { db, repository, id, now } = fixture();
  try {
    const claim = repository.claim(id, now)!;
    db.exec("CREATE TRIGGER fail_delivery BEFORE UPDATE ON reminder BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    assert.throws(() => repository.deliver(claim, now));
    assert.equal(repository.notifications().length, 0);
    assert.equal(repository.get('r1')!.status, 'scheduled');
    assert.equal(repository.timer(id)!.state, 'claimed');
    db.exec('DROP TRIGGER fail_delivery');
    const recovered = repository.claim(id, '2026-10-14T07:00:31.000Z')!;
    repository.deliver(recovered, '2026-10-14T07:00:31.000Z');
    assert.equal(repository.notifications().length, 1);
  } finally { db.close(); }
});

test('重试有界，单项失败不影响其他提醒', () => {
  const { db, repository, reminder, id } = fixture();
  try {
    repository.transaction(() => { const second = { ...reminder, reminderId: 'r2' }; repository.save(second); repository.schedule(second); });
    db.exec("CREATE TRIGGER fail_one BEFORE INSERT ON inbox_notification WHEN NEW.id='notification:r1:1' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    let clock = new Date('2026-10-14T07:00:00.000Z');
    const scheduler = new ReminderScheduler(repository, new WorkbenchEvents(), () => clock, () => {});
    for (let i = 0; i < 6; i++) { scheduler.tick(); clock = new Date(clock.getTime() + 60_000); }
    assert.equal(repository.timer(id)!.attempts, 5);
    assert.equal(repository.get('r1')!.status, 'failed');
    assert.equal(repository.get('r2')!.status, 'delivered');
    assert.equal(repository.notifications().length, 1);
  } finally { db.close(); }
});
