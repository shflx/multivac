import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { TaskSchema, TaskRunSchema, type Task, type TaskRun } from '@multivac/contracts';
import { TASK_MIGRATION, SqliteTaskRepository } from '../../src/storage/sqlite-task-repository.js';
import { TASK_RUN_MIGRATION, SqliteTaskRunRepository } from '../../src/storage/sqlite-task-run-repository.js';
import type { RunOverview } from '../../src/modules/tasks/run-overview.js';

// 固定于 87ab69f3302b91c238ce9e95d45af99fc944d5c6 的查询及完整校验路径，作为独立参照。
export const LEGACY_OVERVIEW_SQL = `SELECT t.record_json AS task_json, r.record_json AS run_json, (s.session_id IS NOT NULL AND s.archived_at IS NULL) AS session_available
  FROM task t LEFT JOIN task_run r ON r.run_id=json_extract(t.record_json, '$.currentRunId')
  LEFT JOIN assistant_session_registry s ON s.session_id=r.session_id
  WHERE json_extract(t.record_json, '$.deletedAt') IS NULL
    AND (r.task_id IS NULL OR r.task_id=t.task_id)
    AND (t.status NOT IN ('idle', 'done', 'cancelled') OR r.stop_confirmed=0)`;
export function legacyOverview(db: DatabaseSync): RunOverview {
  const rows = db.prepare(LEGACY_OVERVIEW_SQL).all();
  const version = Number(db.prepare('SELECT coalesce(max(event_id), 0) AS version FROM task_event').get()!.version);
  return { version, rows: rows.map(row => {
    const task = JSON.parse(String(row.task_json));
    const run = row.run_json ? JSON.parse(String(row.run_json)) : null;
    if (!Check(TaskSchema, task) || (run && !Check(TaskRunSchema, run))) throw new Error('基线完整事实校验失败');
    return { task, run, sessionAvailable: !!row.session_available };
  }) };
}
export function createQueryDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE project(project_id TEXT PRIMARY KEY);
    CREATE TABLE assistant_session_registry(session_id TEXT PRIMARY KEY, archived_at TEXT);`);
  db.exec(TASK_MIGRATION);
  db.exec(TASK_RUN_MIGRATION);
  return db;
}
export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export function makeTask(id: string, patch: Partial<Task> = {}): Task {
  return { taskId: id, title: id, goal: '核对运行事实', scope: '', projectId: null, priority: 'medium', acceptance: true,
    acceptanceCriteria: '', groupId: null, parentTaskId: null, dependencyIds: [], status: 'idle', revision: 1,
    sessionId: null, currentRunId: null, reason: '', nextStep: '', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, completedAt: null, ...patch };
}
export function makeRun(task: Task, patch: Partial<TaskRun> = {}): TaskRun {
  return { runId: `run:${task.taskId}`, taskId: task.taskId, sessionId: `session:${task.taskId}`, commandId: `run:${task.taskId}`,
    status: 'running', stopIntent: null, stopConfirmed: false, ownerId: 'owner', directory: null, baseline: null,
    projectId: null, scope: '', goal: '核对运行事实', pendingToolIds: [], toolFailures: 0, runtimeSessionId: null, runtimeEntryId: null,
    reason: '', createdAt: FIXED_TIME, updatedAt: FIXED_TIME, ...patch };
}
export function saveFacts(db: DatabaseSync, task: Task, run: TaskRun | null, session: 'missing' | 'archived' | 'available' = 'available'): void {
  new SqliteTaskRepository(db).save({ ...task, currentRunId: run?.runId ?? task.currentRunId }, null);
  if (run) {
    new SqliteTaskRunRepository(db).save(run);
    if (session !== 'missing') db.prepare('INSERT INTO assistant_session_registry VALUES (?, ?)').run(run.sessionId, session === 'archived' ? FIXED_TIME : null);
  }
}
