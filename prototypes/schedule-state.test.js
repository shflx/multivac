import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRule, emptySchedule, filterSchedules, formatAt, scheduleProblem, seedSchedules, setScheduleState,
  triggerNow, upcomingOccurrences, zonedToUtc,
} from './schedule-state.js';

const now = new Date('2026-10-30T08:00:00Z'); // 北京时间周五 16:00

test('规则说明区分单次、每天、工作日与每周多天', () => {
  assert.equal(describeRule({ kind: 'once', date: '2026-11-02', time: '17:00' }), '单次 · 2026年11月2日 17:00');
  assert.equal(describeRule({ kind: 'daily', time: '09:00' }), '每天 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [5, 1, 2, 3, 4], time: '09:00' }), '工作日 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [4, 1], time: '18:30' }), '每周一、四 18:30');
});

test('按安排时区计算接下来的触发时间，不使用本地时区', () => {
  const daily = upcomingOccurrences({ kind: 'daily', time: '09:00' }, 'Asia/Shanghai', now, 2).results.map((item) => item.at.toISOString());
  assert.deepEqual(daily, ['2026-10-31T01:00:00.000Z', '2026-11-01T01:00:00.000Z']);
  // 今天 16:00 已到，同一时刻不再计入；跨周取下一个周一。
  const weekly = upcomingOccurrences({ kind: 'weekly', days: [1, 5], time: '16:00' }, 'Asia/Shanghai', now, 2).results.map((item) => item.at.toISOString());
  assert.deepEqual(weekly, ['2026-11-02T08:00:00.000Z', '2026-11-06T08:00:00.000Z']);
  const london = upcomingOccurrences({ kind: 'daily', time: '09:00' }, 'Europe/London', now, 1).results[0].at.toISOString();
  assert.equal(london, '2026-10-30T09:00:00.000Z');
});

test('夏令时缺失的当地时间跳过并留下记录，重复时刻只触发较早的一次', () => {
  assert.equal(zonedToUtc({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, 'America/New_York').status, 'gap');
  const overlap = zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(overlap.status, 'overlap');
  assert.equal(overlap.at.toISOString(), '2026-11-01T05:30:00.000Z');
  const spring = upcomingOccurrences({ kind: 'daily', time: '02:30' }, 'America/New_York', new Date('2027-03-13T12:00:00Z'), 2);
  assert.equal(spring.skipped.length, 1);
  assert.deepEqual(spring.results.map((item) => item.at.toISOString()), ['2027-03-15T06:30:00.000Z', '2027-03-16T06:30:00.000Z']);
  const autumn = upcomingOccurrences({ kind: 'daily', time: '01:30' }, 'America/New_York', new Date('2026-10-31T12:00:00Z'), 2).results;
  assert.equal(autumn[0].note, '夏令时重复时刻，只触发较早的一次');
  assert.equal(autumn[1].at.toISOString(), '2026-11-02T06:30:00.000Z');
});

test('单次规则只在未来时有效；保存校验给出第一条问题', () => {
  assert.equal(upcomingOccurrences({ kind: 'once', date: '2026-10-29', time: '09:00' }, 'Asia/Shanghai', now).results.length, 0);
  const draft = emptySchedule(now);
  assert.equal(scheduleProblem(draft, now), '请填写名称。');
  assert.equal(scheduleProblem({ ...draft, name: '提醒' }, now), '请填写提醒内容。');
  assert.equal(scheduleProblem({ ...draft, name: '检查', action: { ...draft.action, kind: 'agent' } }, now), '请填写要执行的指令。');
  assert.equal(scheduleProblem({ ...draft, name: '周报', action: { ...draft.action, text: '写' }, rule: { kind: 'weekly', days: [], time: '09:00' } }, now), '请至少选择一个星期几。');
  assert.equal(scheduleProblem({ ...draft, name: '提醒', action: { ...draft.action, text: '内容' } }, now), '');
});

test('立即执行使用手动身份不改变计划；上一轮仍占用时记录为跳过', () => {
  const [busy] = seedSchedules(now);
  const skipped = triggerNow(busy, now, 'manual-1');
  assert.equal(skipped.occurrences[0].status, 'skipped');
  assert.match(skipped.occurrences[0].reason, /上一轮仍执行中/);
  assert.deepEqual(skipped.rule, busy.rule);
  const reminder = seedSchedules(now).find((item) => item.id === 'standup');
  const delivered = triggerNow(reminder, now, 'manual-2');
  assert.equal(delivered.occurrences[0].status, 'delivered');
  assert.equal(delivered.occurrences[0].source, 'manual');
});

test('暂停与启用只切换安排状态，不改动已有触发记录', () => {
  const schedule = seedSchedules(now).find((item) => item.id === 'deps-audit');
  const paused = setScheduleState(schedule, 'paused');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.occurrences[0].status, 'running');
  assert.deepEqual(setScheduleState(paused, 'active').occurrences, schedule.occurrences);
});

test('筛选按动作类型、安排状态与名称独立组合，排除已删除', () => {
  const schedules = seedSchedules(now);
  assert.equal(filterSchedules(schedules, { action: 'agent' }).length, 3);
  assert.equal(filterSchedules(schedules, { state: 'paused' }).length, 1);
  assert.equal(filterSchedules(schedules, { query: '周报' }).length, 1);
  assert.equal(filterSchedules([{ ...schedules[0], deleted: true }], {}).length, 0);
});

test('时间显示按安排时区使用今天、明天等相对说法', () => {
  assert.equal(formatAt(new Date('2026-10-30T09:00:00Z'), 'Asia/Shanghai', now), '今天 17:00');
  assert.equal(formatAt(new Date('2026-10-31T01:00:00Z'), 'Asia/Shanghai', now), '明天 09:00');
  assert.equal(formatAt(new Date('2026-11-03T01:00:00Z'), 'Asia/Shanghai', now), '11月3日 周二 09:00');
});
