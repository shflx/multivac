import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetOptions, describeRule, durationLabel, formatAt, nextWholeHour, occurrenceLabel, timeZoneLabel, timeZoneOptions } from '../src/features/schedules/schedule-format.js';

const now = new Date('2026-10-30T08:00:00Z'); // 北京时间周五 16:00

test('规则说明区分单次、每天、工作日与每周多天', () => {
  assert.equal(describeRule({ kind: 'once', localTime: '2026-11-02T17:00:00', scheduledAt: '2026-11-02T09:00:00.000Z' }), '单次 · 2026年11月2日 17:00');
  assert.equal(describeRule({ kind: 'once', localTime: '2026-11-02T17:00:30', scheduledAt: '2026-11-02T09:00:30.000Z' }), '单次 · 2026年11月2日 17:00:30');
  assert.equal(describeRule({ kind: 'daily', time: '09:00' }), '每天 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [5, 1, 2, 3, 4], time: '09:00' }), '工作日 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [0, 4, 1], time: '18:30' }), '每周一、四、日 18:30');
});

test('时间按安排时区使用今天、明天等相对说法，跨年时带年份', () => {
  assert.equal(formatAt('2026-10-30T09:00:00Z', 'Asia/Shanghai', now), '今天 17:00');
  assert.equal(formatAt('2026-10-31T01:00:00Z', 'Asia/Shanghai', now), '明天 09:00');
  assert.equal(formatAt('2026-10-31T01:00:00Z', 'UTC', now), '明天 01:00');
  assert.equal(formatAt('2026-11-03T01:00:00Z', 'Asia/Shanghai', now), '11月3日 周二 09:00');
  assert.equal(formatAt('2027-01-04T01:00:00Z', 'Asia/Shanghai', now), '2027年1月4日 周一 09:00');
  assert.equal(formatAt(null, 'Asia/Shanghai', now), '—');
});

test('提醒成功显示为已提醒，Agent 执行沿用触发状态文案', () => {
  assert.equal(occurrenceLabel('succeeded', 'reminder'), '已提醒');
  assert.equal(occurrenceLabel('succeeded', 'agent'), '成功');
  assert.equal(occurrenceLabel('reconcile', 'agent'), '待恢复核对');
});

test('时区候选保留当前值并去重，常用时区带中文名', () => {
  assert.deepEqual(timeZoneOptions('Europe/Paris', 'Asia/Shanghai').slice(0, 3), ['Europe/Paris', 'Asia/Shanghai', 'Asia/Tokyo']);
  assert.equal(timeZoneLabel('Asia/Shanghai'), '北京时间（Asia/Shanghai）');
  assert.equal(timeZoneLabel('Europe/Paris'), 'Europe/Paris');
});

test('时长候选包含旧安排的自定义额度', () => {
  assert.deepEqual(budgetOptions(30_000).slice(0, 2), [30_000, 15 * 60_000]);
  assert.equal(budgetOptions(30 * 60_000).length, 4);
  assert.equal(durationLabel(30_000), '30 秒');
  assert.equal(durationLabel(6 * 3_600_000), '6 小时');
  assert.equal(durationLabel(90 * 60_000), '90 分钟');
});

test('新单次安排默认取下一个整点，跨天时进位日期', () => {
  assert.deepEqual(nextWholeHour('2026-10-30T16:25:10'), { date: '2026-10-30', time: '17:00' });
  assert.deepEqual(nextWholeHour('2026-10-31T23:40:00'), { date: '2026-11-01', time: '00:00' });
});
