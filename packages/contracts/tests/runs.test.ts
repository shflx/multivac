import assert from 'node:assert/strict';
import test from 'node:test';
import { runDisplayState, isRunAnomaly, runIndicatorState, managedProcessLifecycle } from '../src/runs.js';
import type { Task, TaskRun } from '../src/task.js';

test('停止证据优先于任务标签；未知停止不伪装已结束', () => {
  const task = { status: 'done' } as Task;
  assert.equal(runDisplayState(task, { stopConfirmed: false, status: 'recovery' } as TaskRun), 'recovery');
  assert.equal(runDisplayState(task, { stopConfirmed: false, status: 'stopping', stopIntent: 'pause' } as TaskRun), 'stopping');
  assert.equal(runDisplayState(task, { stopConfirmed: true } as TaskRun), 'settled');
});
test('空闲、仅排队、人工等待和异常使用统一状态', () => {
  assert.equal(runIndicatorState({ running: 0, queued: 0, anomalies: 0, waiting: 0 }), 'idle');
  assert.equal(runIndicatorState({ running: 0, queued: 2, anomalies: 0, waiting: 0 }), 'ok');
  for (const status of ['waiting', 'review', 'paused'] as const) {
    assert.equal(isRunAnomaly(runDisplayState({ status } as Task, null)), false);
  }
  for (const pauseSource of ['budget', 'environment'] as const) {
    assert.equal(isRunAnomaly(runDisplayState({ status: 'paused', pauseSource } as Task, null)), true);
  }
  assert.equal(runDisplayState({ status: 'running' } as Task, null), 'recovery');
});
test('长期进程独立保留，依赖进程随任务收敛，标签页不停止服务', () => {
  for (const action of ['pause', 'cancel', 'complete'] as const) {
    assert.equal(managedProcessLifecycle(action, true), 'stop');
    assert.equal(managedProcessLifecycle(action, false), 'retain');
  }
  assert.equal(managedProcessLifecycle('tab-close', true), 'retain');
  assert.equal(managedProcessLifecycle('service-exit', false), 'stop');
});
