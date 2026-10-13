import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UsageDays } from '@multivac/contracts';
import { aggregateUsage, shiftUsageDate, usageCalendar, type AggregateUsageOptions } from '../src/modules/usage/aggregate-usage.js';
import type { UsageRecord } from '../src/modules/usage/model-usage.js';
import { usageQuery } from '../src/adapters/http/usage-routes.js';

const record = (requestId: string, startedAt: string, total = 60): UsageRecord => ({ requestId, startedAt,
  sessionId: requestId, sessionTitle: requestId, piSessionId: 'pi', provider: 'p', modelId: 'm', projectId: null,
  projectName: null, projectKnown: true, source: 'session', outcome: 'succeeded', origin: 'live', missingReason: null,
  tokens: { input: total / 2, cacheRead: total / 3, output: total / 6, total }, raw: null });
const options = (days: UsageDays, overrides: Partial<AggregateUsageOptions> = {}): AggregateUsageOptions => ({ days, timeZone: 'UTC', now: '2026-10-13T23:59:59.999Z',
  collectionStartedAt: '2026-01-01T00:00:00.000Z', intervals: [{ start: '2026-01-01T00:00:00.000Z', end: '2026-10-13T23:59:59.999Z' }],
  collectionReliable: true, history: 'scanned', reasons: [], ...overrides });

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

test('完整采集的零值、未覆盖、缺失usage、服务停机间隙及未知时间可辨识', () => {
  const zero = aggregateUsage([], options(7));
  assert.equal(zero.coverage.current, 'complete');
  assert.equal(zero.daily[0].coverage, 'complete');
  assert.equal(zero.summary.total, 0);
  assert.equal(zero.delta, null);
  const uncovered = aggregateUsage([], options(7, { intervals: [] }));
  assert.equal(uncovered.coverage.current, 'uncovered');
  assert.equal(uncovered.dailyAverage, null);
  const missing = { ...record('missing', '2026-10-13T12:00:00.000Z'), tokens: null, missingReason: '无usage' };
  const partial = aggregateUsage([missing], options(7));
  assert.equal(partial.summary.requests, 1);
  assert.equal(partial.summary.missingRequests, 1);
  assert.equal(partial.coverage.current, 'partial');
  assert.equal(partial.delta, null);
  const gap = aggregateUsage([], options(7, { intervals: [{ start: '2026-01-01T00:00:00.000Z', end: '2026-10-12T00:00:00.000Z' }, { start: '2026-10-12T01:00:00.000Z', end: '2026-10-13T23:59:59.999Z' }] }));
  assert.equal(gap.daily.find(day => day.date === '2026-10-12')!.coverage, 'partial');
  assert.equal(gap.coverage.current, 'partial');
  const untimed = aggregateUsage([{ ...missing, startedAt: null }], options(7));
  assert.equal(untimed.coverage.unplacedRequests, 1);
  assert.equal(untimed.summary.requests, 0);
  assert.equal(untimed.dailyAverage, null);
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
});

test('查询默认30天，只允许7/30/90和IANA时区，拒绝项目筛选与重复参数', () => {
  assert.deepEqual(usageQuery(new URLSearchParams()), { days: 30, timeZone: 'UTC' });
  assert.deepEqual(usageQuery(new URLSearchParams('days=7&timeZone=Asia%2FShanghai')), { days: 7, timeZone: 'Asia/Shanghai' });
  for (const query of ['days=0', 'days=7&days=30', 'projectId=all', 'timeZone=invalid', 'days=7.0', 'days=NaN', 'timeZone=']) {
    assert.throws(() => usageQuery(new URLSearchParams(query)));
  }
});
