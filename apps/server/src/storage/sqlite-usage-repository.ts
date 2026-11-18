import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord, UsageRepository } from '../modules/usage/model-usage.js';

const subagentRunId = "json_extract(record_json, '$.subagentRunId')";
const tokenTotal = "json_extract(record_json, '$.tokens.total')";

/** 新调用的独立账本；归档、改名和删除会话不会抹去调用事实。 */
export class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS token_usage_request (
        request_id TEXT PRIMARY KEY, started_at TEXT NOT NULL,
        measured INTEGER NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS token_usage_request_time ON token_usage_request(started_at);
      CREATE INDEX IF NOT EXISTS token_usage_subagent_run ON token_usage_request(${subagentRunId}, ${tokenTotal})
        WHERE ${subagentRunId} IS NOT NULL;
      CREATE TABLE IF NOT EXISTS token_usage_collection (
        id INTEGER PRIMARY KEY CHECK (id = 1), started_at TEXT NOT NULL
      );
    `);
  }
  /** 首次接入真实采集时登记一次，重启沿用，用于日均与环比的计算。 */
  startCollection(at: string): void {
    this.database.prepare('INSERT OR IGNORE INTO token_usage_collection VALUES (1, ?)').run(at);
  }
  collectionStartedAt(): string | null {
    return (this.database.prepare('SELECT started_at FROM token_usage_collection WHERE id = 1').get() as { started_at: string } | undefined)?.started_at ?? null;
  }
  put(record: UsageRecord): void {
    const existing = this.database.prepare('SELECT record_json, measured FROM token_usage_request WHERE request_id = ?').get(record.requestId) as { record_json: string; measured: number } | undefined;
    if (existing) {
      const previous = JSON.parse(existing.record_json) as UsageRecord;
      if (previous.sessionId !== record.sessionId || previous.runtimeSessionId !== record.runtimeSessionId) throw new Error('用量请求身份冲突');
      if (existing.measured || (!record.tokens && record.outcome === 'pending')) return;
      // 终态只补用量，调用时的身份与归属保持不变。
      record = { ...previous, outcome: record.outcome, tokens: record.tokens, raw: record.raw, missingReason: record.missingReason };
    }
    this.database.prepare(`INSERT INTO token_usage_request VALUES (?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET measured = excluded.measured, record_json = excluded.record_json`).run(
      record.requestId, record.startedAt, record.tokens ? 1 : 0, JSON.stringify(record));
  }
  subagentTotals(runIds: string[]): Map<string, number | null> {
    if (!runIds.length) return new Map();
    const rows = this.database.prepare(`SELECT ${subagentRunId} AS run_id,
      CASE WHEN count(${tokenTotal}) = count(*) THEN total(${tokenTotal}) END AS tokens
      FROM token_usage_request WHERE ${subagentRunId} IN (${runIds.map(() => '?').join(',')})
      GROUP BY ${subagentRunId}`).all(...runIds);
    return new Map(rows.map(row => [String(row.run_id), row.tokens === null ? null : Number(row.tokens)]));
  }

  records(start?: string, end?: string): UsageRecord[] {
    const rows = start && end
      ? this.database.prepare('SELECT record_json FROM token_usage_request WHERE started_at >= ? AND started_at <= ? ORDER BY started_at, request_id').all(start, end)
      : this.database.prepare('SELECT record_json FROM token_usage_request ORDER BY started_at, request_id').all();
    return (rows as { record_json: string }[]).map(row => JSON.parse(row.record_json) as UsageRecord);
  }
}
