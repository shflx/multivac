import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Check } from 'typebox/value';
import { HumanRequestSchema, type HumanRequest, type HumanRequestQuery, type HumanRequestList } from '@multivac/contracts';
import type { HumanRequestRepository } from '../modules/tasks/human-request.js';
export const HUMAN_REQUEST_MIGRATION = `
  CREATE TABLE IF NOT EXISTS task_human_request (request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(task_id), status TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS task_human_request_task ON task_human_request(task_id,status);
`;
function fromRow(row: unknown): HumanRequest {
  const value: unknown = JSON.parse((row as { record_json: string }).record_json);
  if (!Check(HumanRequestSchema, value)) throw new Error('人工请求记录不符合契约。');
  return value;
}
export class SqliteHumanRequestRepository implements HumanRequestRepository {
  constructor(private readonly database: DatabaseSync) {}
  get(id: string): HumanRequest | null { const row = this.database.prepare('SELECT record_json FROM task_human_request WHERE request_id=?').get(id); return row ? fromRow(row) : null; }
  list(taskId?: string): HumanRequest[] {
    const rows = taskId === undefined ? this.database.prepare("SELECT record_json FROM task_human_request ORDER BY (status='pending') DESC, rowid DESC").all() : this.database.prepare("SELECT record_json FROM task_human_request WHERE task_id=? ORDER BY (status='pending') DESC, rowid DESC").all(taskId);
    return rows.map(fromRow);
  }
  page(query: HumanRequestQuery): HumanRequestList {
    const clauses: string[] = [];
    const args: SQLInputValue[] = [];
    if (query.taskId !== undefined) { clauses.push('task_id=?'); args.push(query.taskId); }
    if (query.status !== undefined) { clauses.push('status=?'); args.push(query.status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (this.database.prepare(`SELECT count(*) AS total FROM task_human_request ${where}`).get(...args) as { total: number }).total;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    const requests = this.database.prepare(`SELECT record_json FROM task_human_request ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(fromRow);
    return { requests, total, nextOffset: offset + requests.length < total ? offset + requests.length : null };
  }
  save(request: HumanRequest): void {
    if (!Check(HumanRequestSchema, request)) throw new Error('人工请求写入不符合契约。');
    this.database.prepare('INSERT INTO task_human_request VALUES (?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json').run(request.requestId, request.taskId, request.status, JSON.stringify(request));
  }
}
