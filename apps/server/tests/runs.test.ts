import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

test('任务会话仍在执行时运行页以运行时事实为准，空闲会话保持运行记录的判定', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    const tasks = new TaskService({ repository: store.tasks, requireProject: () => null });
    const create = (title: string) => tasks.create({ commandId: randomUUID(), title, goal: '核对' }).task;
    const startedAt = new Date(0).toISOString();
    const settledAt = new Date(400).toISOString();
    const rows: { task: Task; run: TaskRun | null; sessionAvailable: boolean }[] = [
      // 暂停未在时限内确认：运行记录已转入恢复核对，但会话仍在执行。
      { task: { ...create('停止未确认'), status: 'recovery' }, sessionAvailable: true, run: { runId: 'run-stuck', sessionId: 'session-stuck', status: 'recovery',
        stopIntent: 'pause', stopConfirmed: false, hasStarted: true, startedAt } as TaskRun },
      // 本轮已结算，会话仍在忙（重试或压缩）。
      { task: { ...create('结算后仍在执行'), status: 'waiting' }, sessionAvailable: true, run: { runId: 'run-busy', sessionId: 'session-busy', status: 'settled',
        stopIntent: null, stopConfirmed: true, hasStarted: true, startedAt, updatedAt: settledAt, elapsedMs: 400 } as TaskRun },
      // 会话已空闲：沿用运行记录，等待用户的任务不进入活跃列表。
      { task: { ...create('已结束'), status: 'waiting' }, sessionAvailable: true, run: { runId: 'run-idle', sessionId: 'session-idle', status: 'settled',
        stopIntent: null, stopConfirmed: true, hasStarted: true, startedAt, updatedAt: settledAt, elapsedMs: 400 } as TaskRun },
    ];
    const live = new Set(['session-stuck', 'session-busy']);
    const runs = new RunsService(() => ({ version: 1, rows }), () => 1000, undefined, sessionId => live.has(sessionId));
    const active = runs.list({ activeOnly: true });
    assert.equal(Check(RunsSnapshotSchema, active), true);
    assert.deepEqual(active.items.map(item => `${item.runId}:${item.state}`).sort(), ['run-busy:running', 'run-stuck:stopping']);
    assert.deepEqual(active.counts, { running: 2, queued: 0, waiting: 0, anomalies: 0 });
    const busy = active.items.find(item => item.runId === 'run-busy')!;
    assert.equal(busy.endedAt, null);
    assert.equal(busy.elapsedMs, 1000);
    assert.equal(active.items.find(item => item.runId === 'run-stuck')!.canPause, false);
    const idle = runs.list().items.find(item => item.runId === 'run-idle')!;
    assert.equal(idle.state, 'waiting');
    assert.equal(idle.endedAt, settledAt);
    assert.equal(idle.elapsedMs, 400);

    live.clear();
    assert.equal(runs.list({ activeOnly: true }).total, 0);
    assert.equal(runs.list().items.find(item => item.runId === 'run-stuck')!.state, 'recovery');
  } finally { store.close(); }
});
