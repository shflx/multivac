import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsageDays } from '@multivac/contracts';
import { aggregateUsage, shiftUsageDate, usageCalendar, type AggregateUsageOptions } from '../src/modules/usage/aggregate-usage.js';
import { measuredUsage, type UsageRecord } from '../src/modules/usage/model-usage.js';
import { usageQuery } from '../src/adapters/http/usage-routes.js';

const record = (requestId: string, startedAt: string, total = 60): UsageRecord => ({ requestId, startedAt,
  sessionId: requestId, sessionTitle: requestId, runtimeSessionId: 'pi', provider: 'p', modelId: 'm', projectId: null,
  projectName: null, projectKnown: true, source: 'session', outcome: 'succeeded', missingReason: null,
  tokens: { input: total / 2, cacheRead: total / 3, output: total / 6, total }, raw: null });
const options = (days: UsageDays, overrides: Partial<AggregateUsageOptions> = {}): AggregateUsageOptions => ({ days, timeZone: 'UTC', now: '2026-10-13T23:59:59.999Z',
  collectionStartedAt: '2026-01-01T00:00:00.000Z', collectionReliable: true, ...overrides });

for (const days of [7, 30, 90] as const) test(`${days}天当前/上期不重叠，每日与所有分布同口径`, () => {
  const records = Array.from({ length: days * 2 + 1 }, (_, index) => record(`r${index}`, `${shiftUsageDate('2026-10-13', -index)}T12:00:00.000Z`));
  records.push(record('future', '2026-10-14T00:00:00.000Z'));
  const result = aggregateUsage(records, options(days));
  assert.equal(result.daily.length, days);
  assert.equal(result.summary.requests, days);
  assert.equal(result.previous.requests, days);
  assert.equal(result.summary.total, days * 60);
  assert.equal(result.delta, 0);
  assert.equal(result.dailyAverage, 60);
  assert.equal(result.daily.reduce((sum, day) => sum + day.total, 0), result.summary.total);
  for (const groups of Object.values(result.distributions)) {
    for (const field of ['input', 'cacheRead', 'output', 'total', 'requests', 'measuredRequests', 'missingRequests'] as const) {
      assert.equal(groups.reduce((sum, group) => sum + group[field], 0), result.summary[field]);
    }
  }
});

test('用户时区跨UTC午夜，DST日历日有23/25小时', () => {
  const shanghai = usageCalendar('Asia/Shanghai');
  assert.equal(shanghai.dateKey(Date.parse('2026-10-12T16:00:00.000Z')), '2026-10-13');
  assert.equal(new Date(shanghai.midnight('2026-10-13')).toISOString(), '2026-10-12T16:00:00.000Z');
  const ny = usageCalendar('America/New_York');
  assert.equal((ny.midnight('2026-03-09') - ny.midnight('2026-03-08')) / 3600000, 23);
  assert.equal((ny.midnight('2026-11-02') - ny.midnight('2026-11-01')) / 3600000, 25);
  const result = aggregateUsage([record('midnight', '2026-10-12T16:00:00.000Z')], options(7, { timeZone: 'Asia/Shanghai', now: '2026-10-13T01:00:00.000Z' }));
  assert.equal(result.daily.at(-1)!.requests, 1);
});

test('空账本正常显示零，新请求缺少用量时保留请求数与提示', () => {
  const zero = aggregateUsage([], options(7));
  assert.equal(zero.summary.total, 0);
  assert.equal(zero.dailyAverage, 0);
  assert.deepEqual(zero.warnings, []);
  assert.ok(zero.daily.every(day => day.total === 0 && day.requests === 0));
  const missing = { ...record('missing', '2026-10-13T12:00:00.000Z'), tokens: null, missingReason: '无usage' };
  const partial = aggregateUsage([missing], options(7));
  assert.equal(partial.summary.requests, 1);
  assert.equal(partial.summary.missingRequests, 1);
  assert.equal(partial.dailyAverage, null);
  assert.equal(partial.delta, null);
  assert.deepEqual(partial.warnings, ['有 1 次请求未返回可确认的用量。']);
});

test('只统计启用后的新调用，日均按实际日历天数，上一周期不足时不比较', () => {
  const records = [record('before', '2026-10-12T23:59:59.999Z'), record('today', '2026-10-13T12:00:00.000Z')];
  for (const days of [7, 30, 90] as const) {
    const result = aggregateUsage(records, options(days, { collectionStartedAt: '2026-10-13T08:00:00.000Z' }));
    assert.equal(result.summary.total, 60);
    assert.equal(result.summary.requests, 1);
    assert.equal(result.statisticsDays, 1);
    assert.equal(result.dailyAverage, 60);
    assert.equal(result.delta, null);
    assert.equal(result.previous.requests, 0);
    assert.ok(result.daily.slice(0, -1).every(day => day.total === 0));
    assert.deepEqual(result.warnings, []);
  }
});

test('日均按用户时区跨日计算，缺失上期用量或采集错误不产生虚假环比', () => {
  const records = [record('today', '2026-10-13T00:00:00.000Z')];
  const local = aggregateUsage(records, options(7, { timeZone: 'Asia/Shanghai', now: '2026-10-13T12:00:00.000Z', collectionStartedAt: '2026-10-12T15:00:00.000Z' }));
  assert.equal(local.statisticsDays, 2);
  assert.equal(local.dailyAverage, 30);
  const previousMissing = { ...record('previous', '2026-10-02T12:00:00.000Z'), tokens: null };
  assert.equal(aggregateUsage([...records, previousMissing], options(7)).delta, null);
  const broken = aggregateUsage(records, options(7, { collectionReliable: false, warnings: ['采集错误'] }));
  assert.equal(broken.dailyAverage, null);
  assert.equal(broken.delta, null);
  assert.deepEqual(broken.warnings, ['采集错误']);
});

test('未知项目独立于无项目，模型提供方不同不合并，Top5来自完整记录', () => {
  const records = Array.from({ length: 8 }, (_, index) => ({ ...record(`session-${index}`, '2026-10-13T12:00:00.000Z', (index + 1) * 60),
    projectKnown: index !== 0, provider: index === 0 ? 'another' : 'p' }));
  const result = aggregateUsage(records, options(7, { sessionTitle: id => id === 'session-7' ? '改名后' : undefined }));
  assert.equal(result.distributions.project.length, 2);
  assert.equal(result.distributions.model.length, 2);
  assert.equal(result.topSessions.length, 5);
  assert.equal(result.topSessions[0].key, 'session-7');
  assert.equal(result.topSessions[0].label, '改名后');
  assert.equal(result.topSessions.at(-1)!.key, 'session-3');
  const renamedProjects = aggregateUsage([
    { ...record('a', '2026-10-13T12:00:00.000Z'), sessionId: 'same', projectId: 'one', projectName: '同名' },
    { ...record('b', '2026-10-13T13:00:00.000Z'), sessionId: 'same', projectId: 'two', projectName: '同名' },
  ], options(7));
  assert.match(renamedProjects.topSessions[0]!.description!, /多个项目归属/);
});

const unmeasured = (id: string, outcome: UsageRecord['outcome'], startedAt = '2026-10-13T12:00:00.000Z'): UsageRecord => ({
  ...record(id, startedAt), sessionId: 'shared', outcome, tokens: null, missingReason: '历史保留的缺失原因',
});

for (const days of [7, 30, 90] as const) test(`${days}天失败、取消和所有pending只保留请求，不阻止日均及满足条件的环比`, () => {
  const exempt = ['failed', 'cancelled', 'pending', 'pending'].map((outcome, index) => unmeasured(`exempt-${index}`, outcome as UsageRecord['outcome']));
  const only = aggregateUsage(exempt, options(days));
  assert.deepEqual(only.summary, { input: 0, cacheRead: 0, output: 0, total: 0, requests: 4, measuredRequests: 0, missingRequests: 0, cacheHitRate: null });
  assert.equal(only.dailyAverage, 0);
  assert.equal(only.delta, null); // 上期没有正数用量，仍不可比较。
  assert.deepEqual(only.warnings, []);
  for (const groups of Object.values(only.distributions)) {
    assert.equal(groups[0]!.requests, 4);
    assert.equal(groups[0]!.missingRequests, 0);
    assert.equal(groups[0]!.share, null);
  }
  const previousAt = `${shiftUsageDate('2026-10-13', -days)}T12:00:00.000Z`;
  const mixed = aggregateUsage([
    ...exempt,
    ...exempt.map(item => ({ ...item, requestId: `previous-${item.requestId}`, startedAt: previousAt })),
    { ...record('measured', '2026-10-13T12:00:00.000Z'), sessionId: 'shared' },
    record('previous-measured', previousAt, 120),
  ], options(days));
  assert.equal(mixed.summary.requests, 5);
  assert.equal(mixed.summary.measuredRequests, 1);
  assert.equal(mixed.summary.missingRequests, 0);
  assert.equal(mixed.summary.total, 60);
  assert.equal(mixed.previous.requests, 5);
  assert.equal(mixed.previous.missingRequests, 0);
  assert.equal(mixed.dailyAverage, 60 / days);
  assert.equal(mixed.delta, -0.5);
  assert.deepEqual(mixed.warnings, []);
  for (const totals of [mixed.daily.at(-1)!, ...Object.values(mixed.distributions).flat(), mixed.topSessions[0]!]) {
    for (const field of ['input', 'cacheRead', 'output', 'total', 'requests', 'measuredRequests', 'missingRequests', 'cacheHitRate'] as const) {
      assert.equal(totals[field], mixed.summary[field]);
    }
  }
  const unreliable = aggregateUsage(exempt, options(days, { collectionReliable: false, warnings: ['采集错误'] }));
  assert.equal(unreliable.dailyAverage, null);
  assert.equal(unreliable.delta, null);
  assert.deepEqual(unreliable.warnings, ['采集错误']);
  assert.equal(aggregateUsage([record('previous', previousAt), ...exempt], options(days, { collectionStartedAt: previousAt })).delta, null);
});

test('终态用量有效性与结果组合：失败取消正数照常累计，仅成功无效用量计缺失', () => {
  const good = { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, totalTokens: 100 };
  const zero = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 };
  for (const [stopReason, outcome] of [['stop', 'succeeded'], ['error', 'failed'], ['aborted', 'cancelled']] as const) {
    for (const usage of [undefined, zero, { ...good, totalTokens: 101 }, good]) {
      const measured = measuredUsage({ role: 'assistant', stopReason, usage });
      assert.equal(measured.outcome, outcome);
      const item = { ...record('result', '2026-10-13T12:00:00.000Z'), ...measured };
      const result = aggregateUsage([item], options(7));
      const valid = usage === good;
      const missing = !valid && outcome === 'succeeded';
      assert.equal(result.summary.requests, 1);
      assert.equal(result.summary.measuredRequests, valid ? 1 : 0);
      assert.equal(result.summary.missingRequests, missing ? 1 : 0);
      assert.equal(result.summary.total, valid ? 100 : 0);
      assert.equal(result.dailyAverage, missing ? null : (valid ? 100 : 0) / 7);
      assert.equal(result.warnings.length, missing ? 1 : 0);
    }
  }
  const mixed = aggregateUsage([
    { ...record('valid', '2026-10-13T12:00:00.000Z'), sessionId: 'shared' },
    unmeasured('success-missing', 'succeeded'), unmeasured('failed', 'failed'), unmeasured('cancelled', 'cancelled'), unmeasured('pending', 'pending'),
  ], options(7));
  assert.equal(mixed.summary.requests, 5);
  assert.equal(mixed.summary.total, 60);
  assert.equal(mixed.summary.missingRequests, 1);
  assert.equal(mixed.dailyAverage, null);
  assert.equal(mixed.delta, null);
  assert.deepEqual(mixed.warnings, ['有 1 次请求未返回可确认的用量。']);
  for (const totals of [mixed.daily.at(-1)!, ...Object.values(mixed.distributions).flat(), mixed.topSessions[0]!]) {
    assert.equal(totals.requests, 5);
    assert.equal(totals.total, 60);
    assert.equal(totals.missingRequests, 1);
  }
});

test('查询默认30天，只允许7/30/90和IANA时区，拒绝项目筛选与重复参数', () => {
  assert.deepEqual(usageQuery(new URLSearchParams()), { days: 30, timeZone: 'UTC' });
  assert.deepEqual(usageQuery(new URLSearchParams('days=7&timeZone=Asia%2FShanghai')), { days: 7, timeZone: 'Asia/Shanghai' });
  for (const query of ['days=0', 'days=7&days=30', 'projectId=all', 'timeZone=invalid', 'days=7.0', 'days=NaN', 'timeZone=']) {
    assert.throws(() => usageQuery(new URLSearchParams(query)));
  }
});
