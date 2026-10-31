import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEDULE_MIGRATION, SqliteScheduleRepository } from '../src/storage/sqlite-schedule-repository.js';
import { ScheduleService } from '../src/application/schedule-service.js';
import { ScheduleScheduler, type ScheduleActionRunner } from '../src/application/schedule-scheduler.js';

function fixture(policy: 'skip' | 'latest' = 'skip') {
  const db = new DatabaseSync(':memory:'); db.exec(SCHEDULE_MIGRATION);
  const repo = new SqliteScheduleRepository(db);
  let time = new Date('2026-01-01T00:00:00Z');
  const now = () => time;
  const service = new ScheduleService(repo, now);
  const item = service.create('session', { commandId: 'create', name: '检查', action: { kind: 'reminder', text: '检查' }, rule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC', missedPolicy: policy });
  const calls: string[] = [];
  const runner: ScheduleActionRunner = { run: async item => { calls.push(item.occurrenceId); return { status: 'succeeded', summary: '完成' }; }, stop: async () => true };
  const scheduler = new ScheduleScheduler(repo, runner, () => {}, now);
  return { db, repo, service, item, runner, calls, scheduler, now, setTime: (at: string) => { time = new Date(at); } };
}
test('重复和竞争扫描不重复执行；游标先提交、单次手动不移动计划', async () => {
  const f = fixture(); f.setTime('2026-01-01T09:00:00Z');
  const other = new ScheduleScheduler(f.repo, f.runner, () => {}, f.now);
  f.scheduler.tick(); other.tick(); await f.scheduler.settle(); await other.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.repo.history(f.item.scheduleId).total, 1);
  const nextAt = f.repo.get(f.item.scheduleId)!.nextAt;
  f.service.control('session', { commandId: 'manual', scheduleId: f.item.scheduleId, revision: 1, operation: 'trigger' });
  f.scheduler.tick(); await f.scheduler.settle(); assert.equal(f.calls.length, 2);
  assert.equal(f.repo.get(f.item.scheduleId)!.nextAt, nextAt); f.db.close();
});
test('暂停仅阻止后续，待核对轮次不重放并阻止重叠；其他安排可继续', async () => {
  const f = fixture(); f.setTime('2026-01-01T09:00:00Z');
  let finish!: () => void;
  f.runner.run = async () => { await new Promise<void>(resolve => { finish = resolve; }); return { status: 'succeeded', summary: '完成' }; };
  f.scheduler.tick(); await Promise.resolve();
  f.service.control('session', { commandId: 'pause', scheduleId: f.item.scheduleId, revision: 1, operation: 'pause' });
  assert.equal(f.repo.active(f.item.scheduleId)!.status, 'running');
  finish(); await f.scheduler.settle();
  f.setTime('2026-01-03T10:00:00Z');
  f.service.control('session', { commandId: 'enable', scheduleId: f.item.scheduleId, revision: 2, operation: 'enable' });
  assert.equal(f.repo.get(f.item.scheduleId)!.nextAt, '2026-01-04T09:00:00.000Z');
  f.service.control('session', { commandId: 'again', scheduleId: f.item.scheduleId, revision: 3, operation: 'trigger' });
  f.scheduler.tick(); await Promise.resolve();
  const recovery = new ScheduleScheduler(f.repo, f.runner, () => {}, f.now); recovery.recover();
  assert.equal(f.repo.active(f.item.scheduleId)!.status, 'reconcile');
  const overlap = f.service.control('session', { commandId: 'overlap', scheduleId: f.item.scheduleId, revision: 3, operation: 'trigger' });
  assert.equal('status' in overlap && overlap.status, 'skipped');
  finish(); await f.scheduler.settle(); assert.equal(f.repo.active(f.item.scheduleId)!.status, 'reconcile'); f.db.close();
});
test('长期离线有界记录区间，仅补最近一次；时钟回退不重复', async () => {
  const f = fixture('latest'); f.setTime('2036-01-01T12:00:00Z'); f.scheduler.tick(); await f.scheduler.settle();
  assert.equal(f.calls.length, 1); assert.ok(f.repo.history(f.item.scheduleId).total <= 3);
  assert.match(f.repo.history(f.item.scheduleId).items.at(-1)!.reason!, /长期离线/);
  f.setTime('2035-12-31T12:00:00Z'); f.scheduler.tick(); await f.scheduler.settle(); assert.equal(f.calls.length, 1); f.db.close();
});
test('默认跳过离线周期，旧单次提醒补发；DST 缺失只记录跳过', async () => {
  const f = fixture(); f.setTime('2026-01-03T12:00:00Z'); f.scheduler.tick(); await f.scheduler.settle(); assert.equal(f.calls.length, 0);
  f.repo.save({ ...f.item, rule: { kind: 'once', scheduledAt: '2026-01-01T09:00:00.000Z', localTime: '2026-01-01T09:00:00' }, scheduleId: 'once', nextAt: '2026-01-01T09:00:00.000Z' });
  f.scheduler.tick(); await f.scheduler.settle(); assert.equal(f.calls.length, 1);
  f.repo.save({ ...f.item, scheduleId: 'dst', timeZone: 'America/New_York', rule: { kind: 'daily', time: '02:30' }, nextAt: '2026-03-08T07:30:00.000Z' });
  f.setTime('2026-03-08T07:30:00Z'); f.scheduler.tick(); await f.scheduler.settle();
  assert.match(f.repo.history('dst').items[0]!.reason!, /DST/); f.db.close();
});
