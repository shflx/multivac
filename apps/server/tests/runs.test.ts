import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { RunsSnapshotSchema } from '@multivac/contracts';
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
