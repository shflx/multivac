import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TASK_BUDGET_MILLIS, TASK_BUDGET_MILLIS_CHOICES, resumeBudgetHint, taskBudgetMillisFromOption, taskBudgetMillisLabel } from './task-budget.js';

test('执行时长档位不足 1 小时按分钟显示，默认 6 小时', () => {
  assert.deepEqual(TASK_BUDGET_MILLIS_CHOICES.map((choice) => choice.label), ['30 分钟', '2 小时', '6 小时', '24 小时']);
  assert.equal(taskBudgetMillisLabel(DEFAULT_TASK_BUDGET_MILLIS), '6 小时');
});

test('非法档位回退到默认值', () => {
  assert.equal(taskBudgetMillisFromOption(String(2 * 3_600_000)), 2 * 3_600_000);
  assert.equal(taskBudgetMillisFromOption('12345'), DEFAULT_TASK_BUDGET_MILLIS);
  assert.equal(taskBudgetMillisFromOption('abc'), DEFAULT_TASK_BUDGET_MILLIS);
});

test('只有已暂停的 Agent 任务提示补充额度，子任务补充共享说明', () => {
  assert.equal(resumeBudgetHint({ status: 'running' }), '');
  assert.equal(resumeBudgetHint({ status: 'paused', humanOnly: true }), '');
  assert.match(resumeBudgetHint({ status: 'paused' }), /按当前偏好补充执行额度/);
  assert.doesNotMatch(resumeBudgetHint({ status: 'paused' }), /父子任务/);
  assert.match(resumeBudgetHint({ status: 'paused', parentTaskId: 'root' }), /父子任务共享补充后的额度/);
});
