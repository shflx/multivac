import type { DatabaseSync } from 'node:sqlite';
import { ManagedProcessSchema, type ManagedProcess } from '@multivac/contracts';
import { Check, Errors } from 'typebox/value';
import type { ManagedProcessRecord, ManagedProcessRepository } from '../modules/processes/managed-process.js';

export const MANAGED_PROCESS_MIGRATION = `CREATE TABLE IF NOT EXISTS managed_process (
  process_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS managed_process_command (
  command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
) STRICT;`;
/** 只索引会进入运行统计的状态，历史终态进程不参与计数扫描。 */
export const MANAGED_PROCESS_COUNTS_MIGRATION = `CREATE INDEX IF NOT EXISTS managed_process_counts_state
  ON managed_process(json_extract(record_json, '$.public.state'))
  WHERE json_extract(record_json, '$.public.state') IN ('starting', 'running', 'stopping', 'recovery');`;

export class SqliteManagedProcessRepository implements ManagedProcessRepository {
  constructor(private readonly database: DatabaseSync) {}
  transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  command(id: string): { fingerprint: string; result: ManagedProcess } | null {
    const row = this.database.prepare('SELECT * FROM managed_process_command WHERE command_id=?').get(id);
    return row ? { fingerprint: String(row.fingerprint), result: JSON.parse(String(row.result_json)) as ManagedProcess } : null;
  }
  batchCommand(id: string): { fingerprint: string; processIds: string[] } | null {
    const row = this.database.prepare('SELECT * FROM managed_process_command WHERE command_id=?').get(id);
    return row ? { fingerprint: String(row.fingerprint), processIds: JSON.parse(String(row.result_json)).processIds } : null;
  }
  saveBatchCommand(id: string, key: string, processIds: string[]) {
    this.database.prepare('INSERT INTO managed_process_command VALUES(?,?,?)').run(id, key, JSON.stringify({ processIds }));
  }
  saveCommand(id: string, key: string, result: ManagedProcess): void {
    this.database.prepare('INSERT INTO managed_process_command VALUES(?,?,?)').run(id, key, JSON.stringify(result));
  }
  private decode(row: Record<string, unknown>): ManagedProcessRecord {
    const record = JSON.parse(String(row.record_json)) as ManagedProcessRecord;
    if (!Check(ManagedProcessSchema, record.public)) throw new Error('托管进程记录不符合契约。');
    return record;
  }
  all(): ManagedProcessRecord[] {
    return this.database.prepare('SELECT record_json FROM managed_process ORDER BY rowid DESC').all().map(row => this.decode(row));
  }
  visible(): ManagedProcessRecord[] {
    return this.database.prepare(`SELECT record_json FROM managed_process WHERE
      COALESCE(json_extract(record_json, '$.public.mode'), 'background') <> 'foreground'
      OR json_extract(record_json, '$.public.state') NOT IN ('exited', 'failed') ORDER BY rowid DESC`).all().map(row => this.decode(row));
  }
  /** 活跃进程都可见；终态前台进程的隐藏规则不影响这两个计数。 */
  counts(activeOnly = false): { processesRunning: number; processesRecovery: number } {
    const row = this.database.prepare(`SELECT
      coalesce(sum(json_extract(record_json, '$.public.state') IN ('starting', 'running', 'stopping')), 0) AS running,
      coalesce(sum(json_extract(record_json, '$.public.state') = 'recovery'), 0) AS recovery
      FROM managed_process
      WHERE json_extract(record_json, '$.public.state') IN ('starting', 'running', 'stopping', 'recovery')`).get()!;
    return { processesRunning: Number(row.running), processesRecovery: activeOnly ? 0 : Number(row.recovery) };
  }
  active(): ManagedProcessRecord[] {
    return this.database.prepare("SELECT record_json FROM managed_process WHERE json_extract(record_json, '$.public.state') NOT IN ('exited', 'failed') ORDER BY rowid DESC").all().map(row => this.decode(row));
  }
  get(id: string): ManagedProcessRecord | undefined {
    const row = this.database.prepare('SELECT record_json FROM managed_process WHERE process_id=?').get(id);
    return row ? this.decode(row) : undefined;
  }
  byCommand(id: string): ManagedProcessRecord | undefined {
    const row = this.database.prepare('SELECT record_json FROM managed_process WHERE command_id=?').get(id);
    return row ? this.decode(row) : undefined;
  }
  save(record: ManagedProcessRecord): void {
    if (!Check(ManagedProcessSchema, record.public)) throw new Error(`托管进程写入不符合契约：${JSON.stringify(Errors(ManagedProcessSchema, record.public).map(error => ({ path: error.instancePath, message: error.message })))}`);
    this.database.prepare('INSERT INTO managed_process VALUES(?,?,?) ON CONFLICT(process_id) DO UPDATE SET record_json=excluded.record_json')
      .run(record.public.processId, record.commandId, JSON.stringify(record));
  }
}
