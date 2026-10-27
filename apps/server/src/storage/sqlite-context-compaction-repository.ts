import type { DatabaseSync } from 'node:sqlite';
import { compactionPending, type ContextCompactionRepository, type StoredContextCompaction } from '../modules/sessions/context-compaction.js';

export const CONTEXT_COMPACTION_MIGRATION = `
  CREATE TABLE IF NOT EXISTS context_compaction (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    record_json TEXT NOT NULL,
    UNIQUE(session_id, operation_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS context_compaction_active ON context_compaction(session_id) WHERE active = 1;
  CREATE INDEX IF NOT EXISTS context_compaction_session ON context_compaction(session_id, sequence DESC);
`;

export class SqliteContextCompactionRepository implements ContextCompactionRepository {
  constructor(private readonly database: DatabaseSync) {}
  private record(row: unknown): StoredContextCompaction | undefined {
    return row ? JSON.parse((row as { record_json: string }).record_json) as StoredContextCompaction : undefined;
  }
  get(sessionId: string, operationId: string) {
    return this.record(this.database.prepare('SELECT record_json FROM context_compaction WHERE session_id = ? AND operation_id = ?').get(sessionId, operationId));
  }
  latest(sessionId: string) {
    return this.record(this.database.prepare('SELECT record_json FROM context_compaction WHERE session_id = ? ORDER BY sequence DESC LIMIT 1').get(sessionId));
  }
  pending(sessionId: string) {
    return this.record(this.database.prepare('SELECT record_json FROM context_compaction WHERE session_id = ? AND active = 1').get(sessionId));
  }
  insert(record: StoredContextCompaction): void {
    const op = record.operation;
    this.database.prepare('INSERT INTO context_compaction(session_id, operation_id, active, record_json) VALUES (?, ?, ?, ?)')
      .run(op.sessionId, op.operationId, Number(compactionPending(op)), JSON.stringify(record));
  }
  finish(record: StoredContextCompaction): void {
    const op = record.operation;
    const result = this.database.prepare('UPDATE context_compaction SET active = ?, record_json = ? WHERE session_id = ? AND operation_id = ?')
      .run(Number(compactionPending(op)), JSON.stringify(record), op.sessionId, op.operationId);
    if (result.changes !== 1) throw new Error('原压缩意图不存在。');
  }
}
