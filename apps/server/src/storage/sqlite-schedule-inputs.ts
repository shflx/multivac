import type { DatabaseSync } from 'node:sqlite';
import type { ScheduleInputRequest } from '@multivac/contracts';
import type { ScheduleInputRepository } from '../application/schedule-input-service.js';
export class SqliteScheduleInputs implements ScheduleInputRepository {
  constructor(private readonly db: DatabaseSync) {}
  all(): ScheduleInputRequest[] { return this.db.prepare('SELECT record_json FROM schedule_input ORDER BY id').all().map(row => JSON.parse(String(row.record_json)) as ScheduleInputRequest); }
  get(id: string): ScheduleInputRequest | null { const row = this.db.prepare('SELECT record_json FROM schedule_input WHERE id=?').get(id); return row ? JSON.parse(String(row.record_json)) as ScheduleInputRequest : null; }
  save(item: ScheduleInputRequest): void { this.db.prepare('INSERT INTO schedule_input VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(item.requestId, item.sessionId, JSON.stringify(item)); }
}
