import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, TaskRun } from '@multivac/contracts';
import { noProgressSince, NO_PROGRESS_MS } from '../src/application/run-observation.js';

test('可控时钟验证阈值、活动恢复与工具和人工等待豁免，不修改停止事实', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const task = { status: 'running' } as Task;
  const run = { status: 'running', stopConfirmed: false, stopIntent: null, pendingToolIds: [], startedAt: at } as unknown as TaskRun;
  const now = Date.parse(at) + NO_PROGRESS_MS;
  assert.equal(noProgressSince(task, run, now - 1), null);
  assert.equal(noProgressSince(task, run, now), at);
  assert.equal(run.stopConfirmed, false);
  assert.equal(noProgressSince(task, { ...run, pendingToolIds: ['long-command'] }, now), null);
  assert.equal(noProgressSince(task, { ...run, nativePendingIds: ['native'] }, now), null);
  assert.equal(noProgressSince(task, { ...run, lastActivityAt: new Date(now).toISOString() }, now), null);
  for (const status of ['waiting', 'review', 'paused', 'recovery'] as const) assert.equal(noProgressSince({ ...task, status }, run, now), null);
  assert.equal(noProgressSince(task, { ...run, stopIntent: 'pause' }, now), null);
});
