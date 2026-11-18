import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { type ManagedProcess, isActiveManagedProcess } from '@multivac/contracts';
import { MANAGED_PROCESS_MIGRATION, MANAGED_PROCESS_COUNTS_MIGRATION, MANAGED_PROCESS_QUERY_MIGRATION, SqliteManagedProcessRepository } from '../src/storage/sqlite-managed-process-repository.js';

// 以旧列表路径为独立参照，覆盖两种执行后端和旧记录缺省 mode。
test('数据库进程聚合与完整可见列表的状态口径一致', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MANAGED_PROCESS_MIGRATION);
    const repository = new SqliteManagedProcessRepository(db);
    for (const state of ['starting', 'running', 'stopping', 'recovery', 'exited', 'failed'] as const) {
      for (const mode of [undefined, 'foreground', 'background'] as const) {
        for (const backend of [undefined, 'bash'] as const) {
          const id = `${state}:${mode ?? 'legacy'}:${backend ?? 'node'}`;
          const item: ManagedProcess = { processId: id, taskId: null, runId: null, sessionId: 'session', revision: 1,
            name: id, command: 'node script.mjs', state, ...(mode ? { mode } : {}), requiredWhileRunning: false,
            startedAt: null, endedAt: null, port: null, exitCode: null, reason: '' };
          repository.save({ public: item, commandId: id, fingerprint: id, directory: '.', token: id, pid: null, ownerId: 'owner', ...(backend ? { backend } : {}) });
        }
      }
    }
    const visible = repository.all().map(record => record.public).filter(p => p.mode !== 'foreground' || !['exited', 'failed'].includes(p.state));
    const expected = { processesRunning: visible.filter(isActiveManagedProcess).length, processesRecovery: visible.filter(item => item.state === 'recovery').length };
    assert.deepEqual(repository.counts(), expected);
    // 迁移兼容已有记录，重复执行不会改变结果。
    db.exec(MANAGED_PROCESS_COUNTS_MIGRATION);
    db.exec(MANAGED_PROCESS_COUNTS_MIGRATION);
    assert.deepEqual(repository.counts(false), expected);
    assert.deepEqual(repository.counts(true), { ...expected, processesRecovery: 0 });
    repository.page = repository.all = () => { throw new Error('计数不得读取列表'); };
    assert.deepEqual(repository.counts(), expected);
    db.exec('DELETE FROM managed_process');
    assert.deepEqual(repository.counts(), { processesRunning: 0, processesRecovery: 0 });
  } finally { db.close(); }
});

test('万条无关历史不进入活跃分页解码，恢复和成功退出分别核对', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(MANAGED_PROCESS_MIGRATION);
    db.exec(MANAGED_PROCESS_QUERY_MIGRATION);
    // 历史行刻意缺少契约字段；若分页解码这些行，测试会失败。
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 10000)
      INSERT INTO managed_process SELECT 'old-' || n, 'old-' || n,
        '{"public":{"state":"exited","sessionId":"other","exitCode":0}}' FROM seq;`);
    const repository = new SqliteManagedProcessRepository(db);
    for (const state of ['running', 'recovery', 'exited'] as const) {
      repository.save({ commandId: state, fingerprint: state, directory: '.', token: state, pid: null, ownerId: 'owner',
        public: { processId: state, taskId: null, runId: 'run', sessionId: 'session', revision: 1,
          name: state, command: 'test', state, requiredWhileRunning: state === 'recovery', startedAt: null,
          endedAt: null, port: null, exitCode: state === 'exited' ? 0 : null, reason: '' } });
    }
    const prepare = db.prepare.bind(db);
    const plans: string[] = [];
    db.prepare = sql => {
      if (sql.includes('FROM managed_process') && sql.startsWith('SELECT')) {
        const params = sql.includes('OFFSET ?') ? [100, 0] : [];
        plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String(row.detail)));
      }
      return prepare(sql);
    };
    assert.deepEqual(repository.page(0, 100, true).processes.map(p => p.state), ['running']);
    assert.ok(plans.filter(plan => plan.includes('managed_process_active')).length >= 2, plans.join('\n'));
    assert.deepEqual(repository.page(0, 2).processes.map(p => p.state), ['recovery', 'running']);
    db.prepare = prepare;
    assert.equal(repository.hasUnfinished({ runId: 'run' }, true), true);
    assert.equal(repository.hasUnfinished({ sessionId: 'other' }), false);
    assert.equal(repository.hasSuccessfulExit('session'), true);
    assert.deepEqual(repository.forSession('session').map(p => p.public.state), ['recovery', 'running', 'exited']);
  } finally { db.close(); }
});
