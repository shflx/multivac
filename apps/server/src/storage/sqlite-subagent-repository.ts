import type { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { SubagentRunSchema } from '@multivac/contracts';
import type { SubagentRecord, SubagentRepository } from '../modules/agents/subagent-run.js';
import { runInTransaction } from './sqlite-transaction.js';

export const SUBAGENT_MIGRATION = `
  CREATE TABLE IF NOT EXISTS subagent_run (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
    parent_session_id TEXT NOT NULL, parent_tool_call_id TEXT NOT NULL,
    stop_confirmed INTEGER NOT NULL, created_at TEXT NOT NULL, record_json TEXT NOT NULL,
    UNIQUE(parent_session_id, parent_tool_call_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS subagent_parent ON subagent_run(parent_session_id, created_at, id);
  CREATE INDEX IF NOT EXISTS subagent_unsettled ON subagent_run(stop_confirmed);
`;
function decode(row: unknown): SubagentRecord | null {
  if (!row) return null;
  const record = JSON.parse((row as { record_json: string }).record_json) as SubagentRecord;
  if (!Check(SubagentRunSchema, record.run)) throw new Error('子智能体运行记录不符合契约。');
  return record;
}
export class SqliteSubagentRepository implements SubagentRepository {
  constructor(private readonly database: DatabaseSync) {}
  transaction<T>(operation: () => T): T { return runInTransaction(this.database, operation); }
  get(id: string): SubagentRecord | null { return decode(this.database.prepare('SELECT record_json FROM subagent_run WHERE id=?').get(id)); }
  bySession(id: string): SubagentRecord | null { return decode(this.database.prepare('SELECT record_json FROM subagent_run WHERE session_id=?').get(id)); }
  byCall(parent: string, call: string): SubagentRecord | null {
    return decode(this.database.prepare('SELECT record_json FROM subagent_run WHERE parent_session_id=? AND parent_tool_call_id=?').get(parent, call));
  }
  page(parent: string, offset: number, limit: number) {
    const total = (this.database.prepare('SELECT count(*) AS n FROM subagent_run WHERE parent_session_id=?').get(parent) as { n: number }).n;
    const items = this.database.prepare('SELECT record_json FROM subagent_run WHERE parent_session_id=? ORDER BY created_at, id LIMIT ? OFFSET ?').all(parent, limit, offset).map(row => decode(row)!);
    return { items, total };
  }
  unsettled(parent?: string): SubagentRecord[] {
    const rows = parent ? this.database.prepare('SELECT record_json FROM subagent_run WHERE stop_confirmed=0 AND parent_session_id=?').all(parent)
      : this.database.prepare('SELECT record_json FROM subagent_run WHERE stop_confirmed=0').all();
    return rows.map(row => decode(row)!);
  }
  resetForTest(): void {
    if (this.unsettled().length) throw new Error('子智能体停止未确认，不能清理测试记录。');
    this.database.exec('DELETE FROM subagent_run; DELETE FROM subagent_parent_budget;');
  }
  counts(): { subagentsRunning: number; subagentsRecovery: number } {
    const row = this.database.prepare(`SELECT count(*) AS total, coalesce(sum(CASE WHEN json_extract(record_json, '$.run.status') IN ('interrupted','reconcile') THEN 1 ELSE 0 END), 0) AS recovery FROM subagent_run WHERE stop_confirmed=0`).get() as { total: number; recovery: number };
    return { subagentsRunning: row.total - row.recovery, subagentsRecovery: row.recovery };
  }
  listPage(query: { parentSessionId?: string; taskId?: string; activeOnly?: boolean; offset: number; limit: number }) {
    const filters: string[] = [], values: (string | number)[] = [];
    if (query.parentSessionId) { filters.push('parent_session_id=?'); values.push(query.parentSessionId); }
    if (query.taskId) { filters.push("json_extract(record_json, '$.run.taskId')=?"); values.push(query.taskId); }
    if (query.activeOnly) filters.push('stop_confirmed=0');
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const total = (this.database.prepare(`SELECT count(*) AS n FROM subagent_run${where}`).get(...values) as { n: number }).n;
    const items = this.database.prepare(`SELECT record_json FROM subagent_run${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...values, query.limit, query.offset).map(row => decode(row)!);
    return { items, total };
  }
  save(record: SubagentRecord): void {
    const run = record.run;
    this.database.prepare(`INSERT INTO subagent_run VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET stop_confirmed=excluded.stop_confirmed, record_json=excluded.record_json`).run(
      run.id, run.sessionId, run.parentSessionId, run.parentToolCallId, run.stopConfirmed ? 1 : 0, run.createdAt, JSON.stringify(record));
  }
}
