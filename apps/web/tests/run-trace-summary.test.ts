import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRunDuration, runTraceSummary } from '../src/features/assistant/run-trace-summary.js';

const START = '2026-09-25T08:00:00.000Z';

function after(ms: number): string {
  return new Date(Date.parse(START) + ms).toISOString();
}

test('不足 60 秒显示秒数，四舍五入且至少 1 秒', () => {
  assert.equal(formatRunDuration(START, after(9_400)), '用时 9 秒');
  assert.equal(formatRunDuration(START, after(9_500)), '用时 10 秒');
  assert.equal(formatRunDuration(START, after(120)), '用时 1 秒');
  assert.equal(formatRunDuration(START, START), '用时 1 秒');
  assert.equal(formatRunDuration(START, after(59_400)), '用时 59 秒');
});

test('满 60 秒显示分秒', () => {
  assert.equal(formatRunDuration(START, after(59_600)), '用时 1 分 0 秒');
  assert.equal(formatRunDuration(START, after(75_000)), '用时 1 分 15 秒');
  assert.equal(formatRunDuration(START, after(62 * 60_000 + 5_000)), '用时 62 分 5 秒');
});

test('时间无法解析或结束早于开始时不给出用时', () => {
  assert.equal(formatRunDuration('not-a-date', after(1_000)), null);
  assert.equal(formatRunDuration(START, after(-1_000)), null);
});

test('摘要运行中显示思考中，结束后显示用时', () => {
  assert.equal(runTraceSummary({ running: true, startedAt: START, endedAt: null }), '思考中');
  assert.equal(runTraceSummary({ running: true, startedAt: START, endedAt: after(3_000) }), '思考中');
  assert.equal(runTraceSummary({ running: false, startedAt: START, endedAt: after(12_000) }), '用时 12 秒');
});

test('缺少结束时间的历史轨迹回退为已结束', () => {
  assert.equal(runTraceSummary({ running: false, startedAt: START, endedAt: null }), '已结束');
  assert.equal(runTraceSummary({ running: false }), '已结束');
  assert.equal(runTraceSummary({ running: false, startedAt: START, endedAt: 'broken' }), '已结束');
});
