import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_TASK_BUDGET, DEFAULT_TASK_BUDGET_MILLIS, type Task } from '@multivac/contracts';
import { PreferencesService, type PreferenceRepository } from '../src/application/preferences-service.js';
import { TaskService } from '../src/application/task-service.js';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

/** 内存偏好仓库：只实现偏好服务用到的最小接口。 */
function memoryPreferences(): PreferenceRepository & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => { values.set(key, value); },
    clearForTest: () => values.clear(),
  };
}

/**
 * 任务树共享的执行时长以“设置 · 偏好”为默认值（默认 6 小时）：新建任务按当时的偏好快照，
 * 已创建的任务保留创建时的预算；没有预算字段的旧记录在执行时按当前偏好计算。
 */
test('任务执行时长默认 6 小时，可经偏好调整且不改动已创建的任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-budget-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const repository = memoryPreferences();
  const preferences = new PreferencesService(repository);
  const tasks = new TaskService({
    repository: store.tasks, runs: store.taskRuns, requireProject: () => {},
    defaultBudget: () => preferences.defaultTaskBudget(),
  });
  const execution = new TaskExecutionService({
    tasks, runs: store.taskRuns, events: new AssistantEventStream(),
    defaultBudget: () => preferences.defaultTaskBudget(),
    prepare: async () => ({ directory: { kind: 'task-isolated', path: root }, baseline: null }),
    createSession: async () => {}, runtime: () => { throw new Error('尚无会话'); },
  });
  try {
    assert.equal(DEFAULT_TASK_BUDGET_MILLIS, 6 * 3_600_000);
    assert.deepEqual(preferences.get(), { tempRetentionDays: 30, recentDays: 7, taskBudgetMillis: DEFAULT_TASK_BUDGET_MILLIS, executionDiagnosticsEnabled: true });
    assert.deepEqual(preferences.defaultTaskBudget(), DEFAULT_TASK_BUDGET);

    const first = tasks.create({ commandId: 'first', title: '默认时长', goal: '核对' }).task;
    assert.deepEqual(first.budget, { maxRuns: 20, maxMillis: 6 * 3_600_000, maxOutputBytes: 16 * 1024 * 1024 });
    assert.equal(execution.budget(first.taskId).remainingMillis, 6 * 3_600_000);

    assert.equal(preferences.update({ taskBudgetMillis: 2 * 3_600_000 }).taskBudgetMillis, 2 * 3_600_000);
    const second = tasks.create({ commandId: 'second', title: '偏好时长', goal: '核对' }).task;
    assert.equal(second.budget?.maxMillis, 2 * 3_600_000);
    // 已创建的任务保留创建时的预算，不随偏好回头改写。
    assert.equal(tasks.get(first.taskId).budget?.maxMillis, 6 * 3_600_000);
    assert.equal(execution.budget(first.taskId).remainingMillis, 6 * 3_600_000);

    // 显式给出的预算不受偏好影响。
    const explicit = tasks.create({ commandId: 'explicit', title: '显式预算', goal: '核对', budget: { maxRuns: 1, maxMillis: 60_000, maxOutputBytes: 4096 } }).task;
    assert.equal(explicit.budget?.maxMillis, 60_000);

    // 旧记录没有预算字段时，执行侧按当前偏好给出余额。
    const { budget: _omitted, ...legacy } = first;
    store.tasks.save({ ...legacy, taskId: 'legacy-without-budget', revision: 1 } as Task, null);
    assert.equal(execution.budget('legacy-without-budget').remainingMillis, 2 * 3_600_000);

    // 存储里出现非法档位时回退默认值，不把任意数字当预算。
    repository.values.set('taskBudgetMillis', 12_345);
    assert.equal(preferences.taskBudgetMillis(), DEFAULT_TASK_BUDGET_MILLIS);
    assert.deepEqual(preferences.update({ recentDays: 1 }).taskBudgetMillis, DEFAULT_TASK_BUDGET_MILLIS);
  } finally {
    execution.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
