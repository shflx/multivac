import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '../modules/usage/model-usage.js';

/** 账本不级联依赖会话/任务，归档、改名和删除不会抹去调用事实。 */
export class SqliteUsageRepository {
  constructor(private readonly database: DatabaseSync, now = new Date().toISOString()) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS model_usage (
        request_id TEXT PRIMARY KEY, started_at TEXT, session_id TEXT NOT NULL,
        measured INTEGER NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS model_usage_time ON model_usage(started_at);
      CREATE INDEX IF NOT EXISTS model_usage_session ON model_usage(session_id, started_at);
      CREATE TABLE IF NOT EXISTS model_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_usage_interval (id TEXT PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL);
    `);
    database.prepare('INSERT OR IGNORE INTO model_usage_meta VALUES (?, ?)').run('collectionStartedAt', now);
    database.prepare('INSERT OR IGNORE INTO model_usage_meta VALUES (?, ?)').run('history', 'pending');
  }
  meta(key: string): string | null {
    return (this.database.prepare('SELECT value FROM model_usage_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.database.prepare('INSERT INTO model_usage_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  put(record: UsageRecord): void {
    // 已有测量值和调用时归属不可被重放覆盖。仅允许为未测量的同一身份补 usage。
    const existing = this.database.prepare('SELECT record_json, measured FROM model_usage WHERE request_id = ?').get(record.requestId) as { record_json: string; measured: number } | undefined;
    if (existing) {
      const previous = JSON.parse(existing.record_json) as UsageRecord;
      if (previous.sessionId !== record.sessionId || previous.piSessionId !== record.piSessionId) throw new Error('用量请求身份冲突');
      if (existing.measured || (!record.tokens && record.outcome === 'pending')) return;
      record = { ...previous, outcome: record.outcome, tokens: record.tokens, raw: record.raw, missingReason: record.missingReason };
    }
    this.database.prepare(`INSERT INTO model_usage VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET measured = excluded.measured, record_json = excluded.record_json`).run(
      record.requestId, record.startedAt, record.sessionId, record.tokens ? 1 : 0, JSON.stringify(record));
  }
  records(start?: string, end?: string): UsageRecord[] {
    const rows = start && end
      ? this.database.prepare('SELECT record_json FROM model_usage WHERE started_at >= ? AND started_at <= ? ORDER BY started_at, request_id').all(start, end)
      : this.database.prepare('SELECT record_json FROM model_usage ORDER BY started_at, request_id').all();
    return (rows as { record_json: string }[]).map(row => JSON.parse(row.record_json) as UsageRecord);
  }
  unplacedCount(): number {
    return Number(this.database.prepare('SELECT count(*) AS count FROM model_usage WHERE started_at IS NULL').get()!.count);
  }
  startInterval(id: string, at: string): void {
    this.database.prepare('INSERT INTO model_usage_interval VALUES (?, ?, ?)').run(id, at, at);
  }
  touchInterval(id: string, at: string): void {
    this.database.prepare('UPDATE model_usage_interval SET end = ? WHERE id = ?').run(at, id);
  }
  intervals(): { start: string; end: string }[] {
    return this.database.prepare('SELECT start, end FROM model_usage_interval ORDER BY start').all() as { start: string; end: string }[];
  }
}
