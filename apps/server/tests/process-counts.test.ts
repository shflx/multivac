import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { type ManagedProcess, isActiveManagedProcess } from '@multivac/contracts';
import { MANAGED_PROCESS_MIGRATION, MANAGED_PROCESS_COUNTS_MIGRATION, SqliteManagedProcessRepository } from '../src/storage/sqlite-managed-process-repository.js';

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
    const visible = repository.visible().map(record => record.public);
    const expected = { processesRunning: visible.filter(isActiveManagedProcess).length, processesRecovery: visible.filter(item => item.state === 'recovery').length };
    assert.deepEqual(repository.counts(), expected);
    // 迁移兼容已有记录，重复执行不会改变结果。
    db.exec(MANAGED_PROCESS_COUNTS_MIGRATION);
    db.exec(MANAGED_PROCESS_COUNTS_MIGRATION);
    assert.deepEqual(repository.counts(false), expected);
    assert.deepEqual(repository.counts(true), { ...expected, processesRecovery: 0 });
    repository.visible = () => { throw new Error('计数不得读取完整列表'); };
    repository.all = repository.visible;
    assert.deepEqual(repository.counts(), expected);
    db.exec('DELETE FROM managed_process');
    assert.deepEqual(repository.counts(), { processesRunning: 0, processesRecovery: 0 });
  } finally { db.close(); }
});
