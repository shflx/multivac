import type { DatabaseSync } from 'node:sqlite';

export const SUBAGENT_BUDGET_MIGRATION = `
  CREATE TABLE IF NOT EXISTS subagent_parent_budget (
    command_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
    max_millis INTEGER NOT NULL, max_bytes INTEGER NOT NULL, output_bytes INTEGER NOT NULL
  ) STRICT;
`;
/** 工作会话本轮的委派共享额度；命令身份不因运行时重建或重复调用而更换。 */
export class SqliteSubagentBudget {
  constructor(private readonly database: DatabaseSync) {}
  open(sessionId: string, commandId: string, startedAt: string, maxMillis: number, maxBytes: number): void {
    this.database.prepare('INSERT OR IGNORE INTO subagent_parent_budget VALUES (?, ?, ?, ?, ?, 0)').run(commandId, sessionId, startedAt, maxMillis, maxBytes);
  }
  remaining(sessionId: string, commandId: string, bytes = 0): { remainingMillis: number; remainingBytes: number } {
    const row = this.database.prepare('SELECT * FROM subagent_parent_budget WHERE command_id=? AND session_id=?').get(commandId, sessionId) as {
      started_at: string; max_millis: number; max_bytes: number; output_bytes: number;
    } | undefined;
    if (!row) throw new Error('父级本轮委派额度尚未登记。');
    if (bytes) this.database.prepare('UPDATE subagent_parent_budget SET output_bytes=output_bytes+? WHERE command_id=? AND session_id=?').run(bytes, commandId, sessionId);
    return { remainingMillis: Math.max(0, row.max_millis - (Date.now() - Date.parse(row.started_at))), remainingBytes: Math.max(0, row.max_bytes - row.output_bytes - bytes) };
  }
  has(commandId: string): boolean { return !!this.database.prepare('SELECT 1 FROM subagent_parent_budget WHERE command_id=?').get(commandId); }
}
