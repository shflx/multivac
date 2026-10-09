import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { isActiveManagedProcess, isActiveRun, RunsSnapshotSchema, type Task, type TaskRun } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { TaskService } from '../src/application/task-service.js';
import { RunsService } from '../src/application/runs-service.js';

test('跨任务统计独立于分页，查询不写事实，缺失会话无假入口', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    const tasks = new TaskService({ repository: store.tasks, requireProject: () => null });
    for (let i = 0; i < 105; i++) {
      const task = tasks.create({ commandId: `create:${i}`, title: `任务 ${i}`, goal: '核对' }).task;
      tasks.transition(task.taskId, { commandId: `queue:${i}`, key: `${i}`, kind: 'queued', summary: '排队' }, (task) => ({ ...task, status: i === 104 ? 'failed' : 'queued' }));
    }
    const runs = new RunsService(() => store.taskRuns.overview(), () => 1000);
    const first = runs.list({ limit: 10 });
    assert.equal(Check(RunsSnapshotSchema, first), true);
    assert.equal(first.items.length, 10);
    assert.equal(first.total, 105);
    assert.deepEqual(first.counts, { running: 0, queued: 104, anomalies: 1, waiting: 0 });
    assert.equal(first.items[0]?.state, 'failed');
    assert.equal(first.items[0]?.sessionAvailable, false);
    assert.equal(first.items[0]?.lastTool, null);
    assert.equal(first.items[1]?.elapsedMs, null);
    assert.equal(runs.list({ offset: 100 }).items.length, 5);
    assert.equal(runs.list({ offset: 100 }).version, first.version);
    assert.throws(() => runs.list({ limit: 101 }), /分页/);
  } finally { store.close(); }
});


test('活跃范围在分页前过滤，统计和摘要不包含排队、暂停、等待或已失败任务', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    const tasks = new TaskService({ repository: store.tasks, requireProject: () => null });
    const rows: { task: Task; run: TaskRun | null; sessionAvailable: boolean }[] = Array.from({ length: 105 }, (_, i) => {
      const task = tasks.create({ commandId: `active:${i}`, title: `执行 ${i}`, goal: '核对' }).task;
      return { task, sessionAvailable: true, run: { runId: `run-${i}`, sessionId: `session-${i}`, status: 'running', stopConfirmed: false,
        startedAt: new Date(0).toISOString(), hasStarted: true, noProgressSince: i === 0 ? new Date(0).toISOString() : null } as TaskRun };
    });
    for (const status of ['queued', 'paused', 'waiting', 'failed', 'recovery', 'done'] as const) {
      const task = tasks.create({ commandId: status, title: status, goal: '历史' }).task;
      rows.push({ task: { ...task, status }, sessionAvailable: false, run: null });
    }
    const runs = new RunsService(() => ({ version: 1, rows }), () => 1000, activeOnly => ({ processesRunning: 2, processesRecovery: activeOnly ? 0 : 1 }));
    const first = runs.list({ activeOnly: true, limit: 10 });
    assert.equal(Check(RunsSnapshotSchema, first), true); assert.equal(first.total, 105); assert.equal(first.items.length, 10);
    assert.deepEqual(first.counts, { running: 105, queued: 0, waiting: 0, anomalies: 1, processesRunning: 2, processesRecovery: 0 });
    assert.ok(first.items.every(isActiveRun)); assert.ok(first.highlights.every(isActiveRun));
    assert.equal(runs.list({ activeOnly: true, offset: 100 }).items.length, 5);
    assert.ok(runs.list().total > first.total);
    for (const state of ['starting', 'running', 'stopping'] as const) assert.equal(isActiveManagedProcess({ state }), true);
    for (const state of ['exited', 'failed', 'recovery'] as const) assert.equal(isActiveManagedProcess({ state }), false);
  } finally { store.close(); }
});
