import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TASK_MIGRATION, SqliteTaskRepository } from '../../apps/server/dist/storage/sqlite-task-repository.js';
import { TASK_RUN_MIGRATION, TASK_RUN_OVERVIEW_MIGRATION, SqliteTaskRunRepository } from '../../apps/server/dist/storage/sqlite-task-run-repository.js';
import { MANAGED_PROCESS_MIGRATION, MANAGED_PROCESS_COUNTS_MIGRATION, SqliteManagedProcessRepository } from '../../apps/server/dist/storage/sqlite-managed-process-repository.js';

export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export const OBSERVED_TIME = Date.parse('2026-01-01T00:01:00.000Z');
function task(id, status, payload) {
  return { taskId: id, title: `性能任务 ${id}`, goal: '可重复的独立数据', scope: payload, projectId: null, priority: 'medium', acceptance: true,
    acceptanceCriteria: '', groupId: null, parentTaskId: null, dependencyIds: [], status, revision: 1,
    sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, completedAt: null };
}
export function createDataset(path, size, profile, optimized) {
  // path 只由调用者的新建临时目录生成，不接受真实数据路径。
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-20000;
    CREATE TABLE project(project_id TEXT PRIMARY KEY);
    CREATE TABLE assistant_session_registry(session_id TEXT PRIMARY KEY, archived_at TEXT);`);
  db.exec(TASK_MIGRATION); db.exec(TASK_RUN_MIGRATION); db.exec(MANAGED_PROCESS_MIGRATION);
  const tasks = new SqliteTaskRepository(db), runs = new SqliteTaskRunRepository(db), processes = new SqliteManagedProcessRepository(db);
  const payload = '固定负载'.repeat(profile === 'waiting-heavy' ? 256 : 64);
  tasks.transaction(() => {
    for (let i = 0; i < size; i++) {
      const id = `task:${String(i).padStart(6, '0')}`;
      const states = profile === 'waiting-heavy' ? ['waiting', 'waiting', 'waiting', 'queued', 'paused'] : ['done', 'done', 'done', 'waiting', 'queued'];
      const item = task(id, i < 8 ? ['running', 'waiting', 'done', 'cancelled', 'idle', 'paused', 'recovery', 'failed'][i] : states[i % states.length], payload);
      if (i < 8 || i % (profile === 'waiting-heavy' ? 10 : 2) === 0) {
        const runId = `run:${id}`, sessionId = `session:${id}`;
        item.currentRunId = runId; item.sessionId = sessionId;
        tasks.save(item, null);
        runs.save({ runId, taskId: id, sessionId, commandId: runId, status: i < 8 ? ['running', 'preparing', 'stopping', 'failed', 'preparing', 'running', 'running', 'settled'][i] : 'settled',
          stopConfirmed: i >= 8, stopIntent: i === 3 ? 'cancel' : i === 5 ? 'pause' : null,
          ...(i === 0 ? {} : { hasStarted: i !== 4 }), ownerId: 'owner', directory: null, baseline: null, projectId: null, scope: payload, goal: '性能数据',
          pendingToolIds: [], toolFailures: 0, runtimeSessionId: null, runtimeEntryId: null, reason: '', createdAt: FIXED_TIME, updatedAt: FIXED_TIME,
          startedAt: FIXED_TIME, elapsedMs: 1000, noProgressSince: i === 0 ? FIXED_TIME : null,
          ...(i % 10 === 0 ? { treeTasks: Array.from({ length: 8 }, (_, index) => task(`snapshot:${i}:${index}`, 'waiting', payload)) } : {}) });
        if (i % 3 !== 0) db.prepare('INSERT INTO assistant_session_registry VALUES (?, ?)').run(sessionId, i % 3 === 1 ? null : FIXED_TIME);
      } else tasks.save(item, null);
    }
    // 额外保留固定六种状态；size 条历史后台退出记录均完整存在。
    for (let i = 0; i < size + 6; i++) {
      const processId = `process:${i}`;
      const mode = i % 3 === 0 ? {} : { mode: i % 3 === 1 ? 'background' : 'foreground' };
      processes.save({ public: { processId, taskId: null, runId: null, sessionId: 'process-session', revision: 1, name: processId,
        command: 'node fixture.mjs', state: i < 6 ? ['starting', 'running', 'stopping', 'recovery', 'failed', 'exited'][i] : 'exited',
        ...(i < 6 ? mode : { mode: 'background' }), requiredWhileRunning: false, startedAt: null, endedAt: null, port: null, exitCode: null, reason: '' },
        commandId: processId, fingerprint: processId, directory: '.', token: processId, ownerId: 'owner', pid: null,
        ...(i % 2 ? { backend: 'bash' } : {}) });
    }
    db.prepare('INSERT INTO task_event(task_id,command_id,revision,kind,summary,occurred_at) VALUES(?,?,?,?,?,?)')
      .run('task:000000', 'fixed-event', 1, 'created', '固定版本', FIXED_TIME);
  });
  if (optimized) { db.exec(TASK_RUN_OVERVIEW_MIGRATION); db.exec(MANAGED_PROCESS_COUNTS_MIGRATION); }
  db.exec('ANALYZE');
  const digest = createHash('sha256');
  for (const table of ['task', 'task_run', 'managed_process']) {
    for (const row of db.prepare(`SELECT record_json FROM ${table} ORDER BY rowid`).iterate()) digest.update(row.record_json).update('\n');
  }
  for (const table of ['assistant_session_registry', 'task_event']) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) digest.update(JSON.stringify(row)).update('\n');
  }
  return { db, tasks, runs, processes, digest: digest.digest('hex'), facts: { tasks: size, processes: size + 6,
    runs: Number(db.prepare('SELECT count(*) n FROM task_run').get().n), unconfirmedRuns: 8,
    backgroundExited: Number(db.prepare("SELECT count(*) n FROM managed_process WHERE json_extract(record_json,'$.public.mode')='background' AND json_extract(record_json,'$.public.state')='exited'").get().n) } };
}
