import type { DatabaseSync } from 'node:sqlite';
import { OCCURRENCE_ACTIVE, type Schedule, type ScheduleOccurrence, type ScheduleQuery } from '@multivac/contracts';
import type { ScheduleRepository } from '../modules/schedules/repository.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import { runInTransaction } from './sqlite-transaction.js';

export const SCHEDULE_MIGRATION = `
CREATE TABLE IF NOT EXISTS schedule (id TEXT PRIMARY KEY, state TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, next_at TEXT, record_json TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS schedule_due ON schedule(state,next_at,id);
CREATE TABLE IF NOT EXISTS schedule_occurrence (id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, planned_at TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS schedule_planned_once ON schedule_occurrence(schedule_id,planned_at) WHERE source='planned';
CREATE INDEX IF NOT EXISTS schedule_history ON schedule_occurrence(schedule_id,planned_at DESC,id);
CREATE TABLE IF NOT EXISTS schedule_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL) STRICT;
`;

export class SqliteScheduleRepository implements ScheduleRepository {
  constructor(readonly db: DatabaseSync) {}
  transaction<T>(operation: () => T): T { return runInTransaction(this.db, operation); }
  receipt<T>(id: string): { fingerprint: string; result: T } | null {
    const row = this.db.prepare('SELECT * FROM schedule_command WHERE id=?').get(id);
    return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result_json)) as T } : null;
  }
  command<T>(id: string, fingerprint: string, operation: () => T): T {
    return this.transaction(() => {
      const previous = this.receipt<T>(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TaskServiceError('COMMAND_ID_CONFLICT', '命令参数与原命令不同，请先对账。');
        return previous.result;
      }
      const result = operation();
      this.db.prepare('INSERT INTO schedule_command VALUES (?,?,?)').run(id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  get(id: string): Schedule | null {
    const row = this.db.prepare('SELECT record_json FROM schedule WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as Schedule : null;
  }
  save(item: Schedule): void {
    this.db.prepare('INSERT INTO schedule VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,kind=excluded.kind,name=excluded.name,next_at=excluded.next_at,record_json=excluded.record_json')
      .run(item.scheduleId, item.state, item.action.kind, item.name, item.nextAt, JSON.stringify(item));
    if (item.legacyReminderId && item.action.kind === 'reminder' && item.rule.kind === 'once') {
      const row = this.db.prepare('SELECT record_json FROM reminder WHERE id=?').get(item.legacyReminderId);
      if (row) {
        const old = JSON.parse(String(row.record_json));
        const status = item.state === 'active' ? 'scheduled' : item.state === 'paused' || item.state === 'deleted' ? 'cancelled' : old.status;
        const next = { ...old, revision: item.revision, text: item.action.text, scheduledAt: item.rule.scheduledAt,
          localTime: item.rule.localTime, timeZone: item.timeZone, status, updatedAt: item.updatedAt };
        this.db.prepare('UPDATE reminder SET status=?,scheduled_at=?,record_json=? WHERE id=?').run(status, next.scheduledAt, JSON.stringify(next), item.legacyReminderId);
      }
    }
  }
  page(query: ScheduleQuery = {}) {
    const clauses: string[] = [], args: (string | number)[] = [];
    if (query.state) { clauses.push('state=?'); args.push(query.state); } else clauses.push("state!='deleted'");
    if (query.kind) { clauses.push('kind=?'); args.push(query.kind); }
    if (query.query) { clauses.push('instr(lower(name),lower(?))>0'); args.push(query.query); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM schedule ${where}`).get(...args)!.n);
    const offset = Math.max(0, query.offset ?? 0), limit = Math.min(100, Math.max(1, query.limit ?? 30));
    const items = this.db.prepare(`SELECT record_json FROM schedule ${where} ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,next_at,id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => JSON.parse(String(row.record_json)) as Schedule);
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  occurrence(id: string): ScheduleOccurrence | null {
    const row = this.db.prepare('SELECT record_json FROM schedule_occurrence WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as ScheduleOccurrence : null;
  }
  saveOccurrence(item: ScheduleOccurrence): void {
    this.db.prepare('INSERT INTO schedule_occurrence VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json')
      .run(item.occurrenceId, item.scheduleId, item.plannedAt, item.source, item.status, JSON.stringify(item));
  }
  history(id: string, offset = 0, limit = 30) {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM schedule_occurrence WHERE schedule_id=?').get(id)!.n);
    const items = this.db.prepare('SELECT record_json FROM schedule_occurrence WHERE schedule_id=? ORDER BY planned_at DESC,id DESC LIMIT ? OFFSET ?').all(id, Math.min(100, Math.max(1, limit)), Math.max(0, offset)).map(row => JSON.parse(String(row.record_json)) as ScheduleOccurrence);
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  active(id: string): ScheduleOccurrence | null {
    const placeholders = OCCURRENCE_ACTIVE.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT record_json FROM schedule_occurrence WHERE schedule_id=? AND status IN (${placeholders}) LIMIT 1`).get(id, ...OCCURRENCE_ACTIVE);
    return row ? JSON.parse(String(row.record_json)) as ScheduleOccurrence : null;
  }
  due(now: string): Schedule[] {
    return this.db.prepare("SELECT record_json FROM schedule WHERE state='active' AND next_at<=? ORDER BY next_at,id LIMIT 100").all(now).map(row => JSON.parse(String(row.record_json)) as Schedule);
  }
  bySession(id: string): ScheduleOccurrence | null {
    const row = this.db.prepare("SELECT record_json FROM schedule_occurrence WHERE json_extract(record_json,'$.sessionId')=? LIMIT 1").get(id);
    return row ? JSON.parse(String(row.record_json)) as ScheduleOccurrence : null;
  }
  unsettled(): ScheduleOccurrence[] {
    const placeholders = OCCURRENCE_ACTIVE.map(() => '?').join(',');
    return this.db.prepare(`SELECT record_json FROM schedule_occurrence WHERE status IN (${placeholders})`).all(...OCCURRENCE_ACTIVE).map(row => JSON.parse(String(row.record_json)) as ScheduleOccurrence);
  }
}

export const SCHEDULE_EXECUTION_MIGRATION = `CREATE INDEX IF NOT EXISTS schedule_occurrence_session ON schedule_occurrence(json_extract(record_json,'$.sessionId'));
CREATE TABLE IF NOT EXISTS schedule_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record_json TEXT NOT NULL) STRICT;`;
