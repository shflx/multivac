import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyUsage, formatShare, formatTokens, groupUsage, seedUsageRecords, shiftDay, summarizeUsage, usageDelta, usageInRange } from './usage-stats.js';

const record = (date, patch = {}) => ({ date, sessionId: 's1', title: '会话一', projectId: 'multivac', source: 'session', modelId: 'openai-main', input: 100, output: 20, cacheRead: 300, requests: 1, ...patch });

test('日期键跨月跨年平移', () => {
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
});

test('按时间范围与项目截取，日常会话用 null 过滤', () => {
  const records = [record('2026-10-12'), record('2026-10-06'), record('2026-10-05'), record('2026-10-12', { projectId: null })];
  assert.equal(usageInRange(records, { today: '2026-10-12', days: 7 }).length, 3);
  assert.equal(usageInRange(records, { today: '2026-10-12', days: 7, projectId: 'multivac' }).length, 2);
  assert.equal(usageInRange(records, { today: '2026-10-12', days: 7, projectId: null }).length, 1);
  // 上一周期：10/05 往前 7 天。
  assert.deepEqual(usageInRange(records, { today: '2026-10-12', days: 7, offsetDays: 7 }).map((item) => item.date), ['2026-10-05']);
});

test('总用量包含缓存命中，命中率按全部输入计算', () => {
  const summary = summarizeUsage([record('2026-10-12'), record('2026-10-11', { input: 300, cacheRead: 100 })]);
  assert.equal(summary.total, 100 + 20 + 300 + 300 + 20 + 100);
  assert.equal(summary.cacheHitRate, 400 / 800);
  assert.equal(summarizeUsage([]).cacheHitRate, 0);
});

test('按天汇总补齐没有用量的日子', () => {
  const days = dailyUsage([record('2026-10-12'), record('2026-10-12'), record('2026-10-10')], { today: '2026-10-12', days: 3 });
  assert.deepEqual(days.map((day) => [day.date, day.total]), [['2026-10-10', 420], ['2026-10-11', 0], ['2026-10-12', 840]]);
});

test('分组按总用量降序，占比相加为 1', () => {
  const groups = groupUsage([record('2026-10-12'), record('2026-10-12', { modelId: 'anthropic-main', input: 1000 })], 'model');
  assert.deepEqual(groups.map((group) => group.key), ['anthropic-main', 'openai-main']);
  assert.equal(groups.reduce((sum, group) => sum + group.share, 0), 1);
  assert.deepEqual(groupUsage([record('2026-10-12', { projectId: null })], 'project').map((group) => group.key), [null]);
});

test('上一周期没有用量时不给变化比例', () => {
  assert.equal(usageDelta(150, 100), 0.5);
  assert.equal(usageDelta(150, 0), null);
});

test('示例数据确定且不晚于今天', () => {
  const first = seedUsageRecords('2026-10-12', 30);
  assert.deepEqual(first, seedUsageRecords('2026-10-12', 30));
  assert.ok(first.length > 0);
  assert.ok(first.every((item) => item.date <= '2026-10-12' && item.date >= '2026-09-13'));
});

test('用量与占比的显示格式', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_345), '12.3K');
  assert.equal(formatTokens(4_560_000), '4.56M');
  assert.equal(formatShare(0.4567), '45.7%');
});
