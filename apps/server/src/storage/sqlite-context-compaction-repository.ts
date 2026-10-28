import { noteCodecFor } from './note-record-codec.js';
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
    if (!row) return undefined;
    const value = row as { session_id: string; operation_id: string; record_json: string };
    const codec = noteCodecFor(this.database), owner = codec?.owner(value.session_id);
    return owner && codec ? codec.decode(owner, 'compaction', value.operation_id, value.record_json) : JSON.parse(value.record_json) as StoredContextCompaction;
  }
  get(sessionId: string, operationId: string) {
    return this.record(this.database.prepare('SELECT session_id,operation_id,record_json FROM context_compaction WHERE session_id = ? AND operation_id = ?').get(sessionId, operationId));
  }
  latest(sessionId: string) {
    return this.record(this.database.prepare('SELECT session_id,operation_id,record_json FROM context_compaction WHERE session_id = ? ORDER BY sequence DESC LIMIT 1').get(sessionId));
  }
  pending(sessionId: string) {
    return this.record(this.database.prepare('SELECT session_id,operation_id,record_json FROM context_compaction WHERE session_id = ? AND active = 1').get(sessionId));
  }
  private encode(record: StoredContextCompaction): string {
    const codec = noteCodecFor(this.database), owner = codec?.owner(record.operation.sessionId);
    return owner && codec ? codec.encode(owner, 'compaction', record.operation.operationId, record) : JSON.stringify(record);
  }
  insert(record: StoredContextCompaction): void {
    const op = record.operation;
    this.database.prepare('INSERT INTO context_compaction(session_id, operation_id, active, record_json) VALUES (?, ?, ?, ?)')
      .run(op.sessionId, op.operationId, Number(compactionPending(op)), this.encode(record));
  }
  finish(record: StoredContextCompaction): void {
    const op = record.operation;
    const result = this.database.prepare('UPDATE context_compaction SET active = ?, record_json = ? WHERE session_id = ? AND operation_id = ?')
      .run(Number(compactionPending(op)), this.encode(record), op.sessionId, op.operationId);
    if (result.changes !== 1) throw new Error('原压缩意图不存在。');
  }
}
