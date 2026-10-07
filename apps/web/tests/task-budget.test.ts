import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TASK_BUDGET_MILLIS } from '@multivac/contracts';
import { TASK_BUDGET_MILLIS_CHOICES, taskBudgetHint, taskBudgetMillisFromOption, taskBudgetMillisLabel } from '../src/features/tasks/task-budget.js';

test('执行时长档位固定为四档，默认 6 小时', () => {
  assert.equal(DEFAULT_TASK_BUDGET_MILLIS, 6 * 3_600_000);
  assert.deepEqual(TASK_BUDGET_MILLIS_CHOICES.map((choice) => choice.value), [1_800_000, 7_200_000, 21_600_000, 86_400_000]);
  assert.deepEqual(TASK_BUDGET_MILLIS_CHOICES.map((choice) => choice.label), ['30 分钟', '2 小时', '6 小时', '24 小时']);
});

test('档位文案与解析：整小时写小时，非法值回退默认档', () => {
  assert.equal(taskBudgetMillisLabel(30 * 60_000), '30 分钟');
  assert.equal(taskBudgetMillisLabel(DEFAULT_TASK_BUDGET_MILLIS), '6 小时');
  assert.equal(taskBudgetMillisFromOption('7200000'), 2 * 3_600_000);
  // 旧默认值（15 分钟）不再是档位，与空值一样回退到 6 小时。
  assert.equal(taskBudgetMillisFromOption('900000'), DEFAULT_TASK_BUDGET_MILLIS);
  assert.equal(taskBudgetMillisFromOption(''), DEFAULT_TASK_BUDGET_MILLIS);
});

test('行说明写清任务树共享、累计口径与作用范围', () => {
  const hint = taskBudgetHint();
  assert.match(hint, /任务树共享/);
  assert.match(hint, /包含工具执行与等待/);
  assert.match(hint, /新建任务和点击“继续任务”/);
  assert.match(hint, /修改偏好不会直接改变已有任务/);
  assert.match(hint, /历史记录保留/);
});
