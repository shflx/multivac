import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewSchedule, resolveScheduleLocal, validateScheduleRule } from '../src/schedule-time.js';

test('跨日、跨周及多星期几按指定时区计算', () => {
  assert.deepEqual(previewSchedule({ kind: 'weekly', time: '09:00', days: [1, 5] }, 'Asia/Shanghai', new Date('2026-10-30T02:00:00Z'), 3).map(x => x.scheduledAt), ['2026-11-02T01:00:00.000Z', '2026-11-06T01:00:00.000Z', '2026-11-09T01:00:00.000Z']);
  assert.equal(previewSchedule({ kind: 'daily', time: '00:15' }, 'Pacific/Auckland', new Date('2026-10-30T12:00:00Z'), 1)[0]!.localTime, '2026-11-01T00:15:00');
});
test('DST 缺失有记录，重复固定为较早偏移，支持半小时变化', () => {
  assert.equal(resolveScheduleLocal('2026-03-08T02:30:00', 'America/New_York').skipReason, 'dst-gap');
  assert.equal(resolveScheduleLocal('2026-11-01T01:30:00', 'America/New_York').scheduledAt, '2026-11-01T05:30:00.000Z');
  assert.equal(resolveScheduleLocal('2026-10-04T02:15:00', 'Australia/Lord_Howe').skipReason, 'dst-gap');
  const preview = previewSchedule({ kind: 'daily', time: '02:30' }, 'America/New_York', new Date('2026-03-07T08:00:00Z'), 2);
  assert.deepEqual(preview.map(x => x.skipReason), ['dst-gap', null]);
});
test('单次保留明确偏移，拒绝不一致和无效时间', () => {
  const now = new Date('2026-01-01Z');
  assert.doesNotThrow(() => validateScheduleRule({ kind: 'once', scheduledAt: '2026-11-01T01:30:00-05:00', localTime: '2026-11-01T01:30:00' }, 'America/New_York', now));
  assert.throws(() => validateScheduleRule({ kind: 'once', scheduledAt: '2026-03-08T02:30:00-05:00', localTime: '2026-03-08T02:30:00' }, 'America/New_York', now));
  assert.throws(() => resolveScheduleLocal('2026-02-30T12:00:00', 'UTC'));
});
