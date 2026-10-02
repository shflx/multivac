import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { TaskRunSchema, type TaskRun } from '@multivac/contracts';
import type { TaskRunRepository } from '../modules/tasks/task.js';

export const TASK_RUN_MIGRATION = `
  CREATE TABLE IF NOT EXISTS task_run (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(task_id),
    session_id TEXT NOT NULL, stop_confirmed INTEGER NOT NULL,
    record_json TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS task_run_task ON task_run(task_id);
  CREATE UNIQUE INDEX IF NOT EXISTS task_run_session_lease ON task_run(session_id) WHERE stop_confirmed = 0;
`;
function fromRow(row: unknown): TaskRun {
  const value: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(TaskRunSchema, value)) throw new Error('任务运行记录不符合契约。');
  return value;
}
export class SqliteTaskRunRepository implements TaskRunRepository {
  constructor(private readonly database: DatabaseSync) {}
  get(runId: string): TaskRun | null {
    const row = this.database.prepare('SELECT record_json FROM task_run WHERE run_id=?').get(runId);
    return row ? fromRow(row) : null;
  }
  list(taskId: string): TaskRun[] {
    return this.database.prepare('SELECT record_json FROM task_run WHERE task_id=? ORDER BY rowid DESC LIMIT 100').all(taskId).map(fromRow);
  }
  active(): TaskRun[] { return this.database.prepare('SELECT record_json FROM task_run WHERE stop_confirmed=0 ORDER BY rowid').all().map(fromRow); }
  bySession(sessionId: string): TaskRun | null {
    const row = this.database.prepare('SELECT record_json FROM task_run WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId);
    return row ? fromRow(row) : null;
  }
  tree(taskId: string): TaskRun[] {
    return this.database.prepare(`WITH RECURSIVE members(id) AS (VALUES(?) UNION SELECT t.task_id FROM task t JOIN members m ON t.parent_id=m.id)
      SELECT record_json FROM task_run WHERE task_id IN (SELECT id FROM members) ORDER BY rowid`).all(taskId).map(fromRow);
  }
  save(run: TaskRun): void {
    if (!Check(TaskRunSchema, run)) throw new Error('运行写入不符合契约。');
    this.database.prepare('INSERT INTO task_run VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET stop_confirmed=excluded.stop_confirmed, record_json=excluded.record_json')
      .run(run.runId, run.taskId, run.sessionId, run.stopConfirmed ? 1 : 0, JSON.stringify(run));
  }
}
