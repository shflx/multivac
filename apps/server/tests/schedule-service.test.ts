import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEDULE_MIGRATION, SqliteScheduleRepository } from '../src/storage/sqlite-schedule-repository.js';
import { ScheduleService } from '../src/application/schedule-service.js';
import { makeOccurrence } from '../src/modules/schedules/occurrence.js';

export function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEDULE_MIGRATION);
  const repository = new SqliteScheduleRepository(db);
  let time = new Date('2026-01-01T00:00:00Z');
  const now = () => time;
  const service = new ScheduleService(repository, now);
  const create = (commandId = 'create') => service.create('session', { commandId, name: '提醒', action: { kind: 'reminder', text: '喝水' }, rule: { kind: 'daily', time: '09:00' }, timeZone: 'Asia/Shanghai', missedPolicy: 'skip' });
  return { db, repository, service, create, now, setTime: (at: string) => { time = new Date(at); } };
}
test('命令幂等、冲突、版本校验、历史快照及删除墓碑', () => {
  const f = fixture(); const item = f.create();
  assert.deepEqual(f.create(), item);
  assert.throws(() => f.service.create('session', { ...item, commandId: 'create' }));
  const trigger = f.service.control('session', { commandId: 'trigger', scheduleId: item.scheduleId, revision: 1, operation: 'trigger' });
  assert.deepEqual(f.service.control('session', { commandId: 'trigger', scheduleId: item.scheduleId, revision: 1, operation: 'trigger' }), trigger);
  const stopped = f.service.control('session', { commandId: 'stop', scheduleId: item.scheduleId, revision: 1, operation: 'stop' });
  assert.equal('status' in stopped && stopped.status, 'stopped');
  const paused = f.service.control('session', { commandId: 'pause', scheduleId: item.scheduleId, revision: 1, operation: 'pause' });
  assert.equal('revision' in paused && paused.revision, 2);
  assert.throws(() => f.service.control('session', { commandId: 'old', scheduleId: item.scheduleId, revision: 1, operation: 'enable' }));
  const removed = f.service.control('session', { commandId: 'delete', scheduleId: item.scheduleId, revision: 2, operation: 'delete' });
  assert.equal('state' in removed && removed.state, 'deleted');
  assert.equal(f.repository.history(item.scheduleId).items[0]!.snapshot.state, 'active');
  assert.equal(f.repository.page().total, 0);
  assert.equal(f.repository.history(item.scheduleId).total, 1);
  f.db.close();
});
test('同计划时刻跨版本不重复，分页筛选由数据库执行', () => {
  const f = fixture(); const item = f.create();
  const a = makeOccurrence(item, 'a', item.nextAt!, 'planned'); f.repository.saveOccurrence(a);
  assert.throws(() => f.repository.saveOccurrence({ ...a, occurrenceId: 'b', scheduleRevision: 2 }));
  assert.equal(f.repository.page({ kind: 'agent' }).total, 0);
  const other = f.create('other');
  assert.equal(f.repository.page({ limit: 1 }).nextOffset, 1);
  assert.equal(f.repository.page({ offset: 1 }).items.length, 1);
  assert.notEqual(item.scheduleId, other.scheduleId); f.db.close();
});
