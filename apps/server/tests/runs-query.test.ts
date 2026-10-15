import assert from 'node:assert/strict';
import test from 'node:test';
import { isActiveRun } from '@multivac/contracts';
import { RunsService } from '../src/application/runs-service.js';
import { SqliteTaskRunRepository, TASK_RUN_OVERVIEW_MIGRATION } from '../src/storage/sqlite-task-run-repository.js';
import { createQueryDatabase, legacyOverview, makeTask, makeRun, saveFacts } from './fixtures/runs-query.js';

test('提前筛选和字段投影与旧查询保持完整范围、摘要、排序及版本契约', () => {
  const db = createQueryDatabase();
  try {
    db.exec(TASK_RUN_OVERVIEW_MIGRATION);
    let id = 0;
    // 任务标签不能替代运行的停止证据；每个任务状态均覆盖未开始、准备、停止和停止未确认。
    for (const status of ['idle', 'queued', 'running', 'waiting', 'review', 'paused', 'done', 'cancelled', 'failed', 'recovery'] as const) {
      for (const runStatus of ['preparing', 'running', 'stopping', 'settled', 'failed', 'paused', 'cancelled', 'recovery'] as const) {
        for (const stopConfirmed of [false, true]) {
          for (const hasStarted of [undefined, false, true]) {
            for (const stopIntent of [null, 'pause', 'cancel'] as const) {
              const key = `matrix:${id++}`;
              const task = makeTask(key, { status });
              const run = makeRun(task, { status: runStatus, stopConfirmed, ...(hasStarted === undefined ? {} : { hasStarted }), stopIntent,
                noProgressSince: id % 2 ? '2026-01-01T00:00:01.000Z' : null, lastTool: 'read', elapsedMs: 100,
                treeTasks: [task], scope: '运行详情'.repeat(100) });
              saveFacts(db, task, run, (['missing', 'archived', 'available'] as const)[id % 3]);
            }
          }
        }
      }
      for (const pauseSource of [undefined, 'user', 'human', 'budget', 'environment'] as const) {
        saveFacts(db, makeTask(`no-run:${id++}`, { status, ...(pauseSource ? { pauseSource } : {}) }), null);
      }
    }
    const deleted = makeTask('deleted', { status: 'running', deletedAt: '2026-01-02' });
    saveFacts(db, deleted, makeRun(deleted));
    const owner = makeTask('owner', { status: 'done' });
    const wrongRun = makeRun(owner);
    saveFacts(db, owner, wrongRun);
    saveFacts(db, makeTask('wrong-reference', { status: 'running', currentRunId: wrongRun.runId }), null);
    // 停止未确认但已不是当前引用的历史运行不能冒充当前执行。
    const historical = makeTask('historical', { status: 'waiting' });
    saveFacts(db, historical, null);
    const repository = new SqliteTaskRunRepository(db);
    repository.save(makeRun(historical));
    db.prepare('INSERT INTO task_event(task_id,command_id,revision,kind,summary,occurred_at) VALUES(?,?,?,?,?,?)')
      .run(historical.taskId, 'event', 1, 'created', '版本依据全部事件', '2026-01-03');

    const now = () => Date.parse('2026-01-01T00:01:00.000Z');
    const baseline = new RunsService(() => legacyOverview(db), now);
    const optimized = new RunsService(activeOnly => repository.overview(activeOnly), now);
    for (const activeOnly of [undefined, false, true]) {
      for (const offset of [0, 1, 100, 1000, 10000]) {
        const query = { ...(activeOnly === undefined ? {} : { activeOnly }), limit: 10, offset };
        assert.deepEqual(optimized.list(query), baseline.list(query), JSON.stringify(query));
      }
    }
    const candidates = repository.overview(true);
    assert.ok(candidates.rows.every(row => row.run?.stopConfirmed === false));
    assert.ok(candidates.rows.every(row => !('scope' in row.task) && !('treeTasks' in row.run!)));
    assert.ok(!candidates.rows.some(row => ['wrong-reference', 'historical', 'deleted'].includes(row.task.taskId)));
    assert.ok(optimized.list({ activeOnly: true }).items.every(isActiveRun));
    assert.equal(optimized.list({ activeOnly: true }).version, 1);
    assert.ok(candidates.rows.length < repository.overview(false).rows.length);
  } finally { db.close(); }
});

test('大量非活跃任务不会进入活跃查询的解析与校验路径', () => {
  const db = createQueryDatabase();
  try {
    db.exec(TASK_RUN_OVERVIEW_MIGRATION);
    const task = makeTask('active', { status: 'done' });
    saveFacts(db, task, makeRun(task, { status: 'preparing', hasStarted: true }));
    // 这里故意使用损坏的历史记录：若候选查询仍处理它，旧路径的完整校验会失败。
    db.prepare('INSERT INTO task(task_id,project_id,group_id,parent_id,status,revision,created_at,record_json) VALUES(?,NULL,NULL,NULL,?,1,?,?)')
      .run('inactive', 'waiting', '', JSON.stringify({ taskId: 'inactive', status: 'waiting' }));
    const repository = new SqliteTaskRunRepository(db);
    assert.equal(repository.overview(true).rows.length, 1);
    assert.throws(() => repository.overview(false), /事实/);
    assert.throws(() => legacyOverview(db), /校验/);
  } finally { db.close(); }
});
