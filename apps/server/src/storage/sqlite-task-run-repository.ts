import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { TaskRunSchema, type TaskRun } from '@multivac/contracts';
import { RunOverviewTaskSchema, RunOverviewExecutionSchema, type RunOverview } from '../modules/tasks/run-overview.js';
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
/** 从未确认停止的运行进入查询，避免随任务历史增长扫描整个任务表。 */
export const TASK_RUN_OVERVIEW_MIGRATION = `CREATE INDEX IF NOT EXISTS task_run_unconfirmed_task
  ON task_run(task_id, run_id) WHERE stop_confirmed=0;`;

// 字段只来自内部契约。JSON 子类型保留布尔值；可选空值省略后仍保持显示语义。
function projection(alias: 't' | 'r', schema: { properties: Record<string, unknown>; required?: string[] }): string {
  const fields = Object.keys(schema.properties);
  const object = (keys: string[]) => `json_object(${keys.map(key => `'${key}', ${alias}.record_json -> '$.${key}'`).join(', ')})`;
  return `json_patch(${object(fields.filter(key => schema.required?.includes(key)))}, ${object(fields.filter(key => !schema.required?.includes(key)))})`;
}

/** 同时用于查询和独立性能脚本的 EXPLAIN，避免测量另一份优化 SQL。 */
export function runOverviewSql(activeOnly = false): string {
  const from = activeOnly
    ? `task_run r INDEXED BY task_run_unconfirmed_task
       JOIN task t ON t.task_id=r.task_id AND r.run_id=json_extract(t.record_json, '$.currentRunId')`
    : `task t LEFT JOIN task_run r ON r.run_id=json_extract(t.record_json, '$.currentRunId')`;
  const scope = activeOnly ? 'r.stop_confirmed=0' : `(r.task_id IS NULL OR r.task_id=t.task_id)
    AND (t.status NOT IN ('idle', 'done', 'cancelled') OR r.stop_confirmed=0)`;
  return `SELECT ${projection('t', RunOverviewTaskSchema)} AS task_json,
    CASE WHEN r.run_id IS NOT NULL THEN ${projection('r', RunOverviewExecutionSchema)} END AS run_json,
    (s.session_id IS NOT NULL AND s.archived_at IS NULL) AS session_available
    FROM ${from}
    LEFT JOIN assistant_session_registry s ON s.session_id=r.session_id
    WHERE ${scope} AND json_extract(t.record_json, '$.deletedAt') IS NULL`;
}

function fromRow(row: unknown): TaskRun {
  const value: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(TaskRunSchema, value)) throw new Error('任务运行记录不符合契约。');
  return value;
}
export class SqliteTaskRunRepository implements TaskRunRepository {
  constructor(private readonly database: DatabaseSync) {}
  /** 仓储只缩小候选范围，最终活跃判断、统计和摘要仍由共享显示契约处理。 */
  overview(activeOnly = false): RunOverview {
    const rows = this.database.prepare(runOverviewSql(activeOnly)).all();
    const version = Number(this.database.prepare('SELECT coalesce(max(event_id), 0) AS version FROM task_event').get()!.version);
    return { version, rows: rows.map((row) => {
      const task: unknown = JSON.parse(String(row.task_json));
      const run: unknown = row.run_json ? JSON.parse(String(row.run_json)) : null;
      if (!Check(RunOverviewTaskSchema, task) || (run !== null && !Check(RunOverviewExecutionSchema, run))) throw new Error('运行显示事实不符合契约。');
      return { task: task as RunOverview['rows'][number]['task'], sessionAvailable: !!row.session_available,
        run: run as RunOverview['rows'][number]['run'] };
    }) };
  }
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
