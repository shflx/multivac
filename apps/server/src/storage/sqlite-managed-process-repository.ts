import type { DatabaseSync } from 'node:sqlite';
import { ManagedProcessSchema, type ManagedProcess } from '@multivac/contracts';
import { Check, Errors } from 'typebox/value';
import type { ManagedProcessRecord, ManagedProcessRepository, ProcessPage, ProcessScope } from '../modules/processes/managed-process.js';
import { runInTransaction } from './sqlite-transaction.js';

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

const state = "json_extract(record_json, '$.public.state')";
const terminal = `${state} IN ('exited', 'failed')`;
const unfinished = `NOT (${terminal})`;
const active = `${state} IN ('starting', 'running', 'stopping')`;
const visible = `COALESCE(json_extract(record_json, '$.public.mode'), 'background') <> 'foreground' OR ${unfinished}`;
const session = "json_extract(record_json, '$.public.sessionId')";
const run = "json_extract(record_json, '$.public.runId')";
const required = "json_extract(record_json, '$.public.requiredWhileRunning') = 1";
const successful = `${state} = 'exited' AND json_extract(record_json, '$.public.exitCode') = 0`;
const newestFirst = `(${terminal}), rowid DESC`;

export const MANAGED_PROCESS_QUERY_MIGRATION = `
  CREATE INDEX IF NOT EXISTS managed_process_visible ON managed_process((${terminal}) DESC) WHERE ${visible};
  CREATE INDEX IF NOT EXISTS managed_process_active ON managed_process((${active})) WHERE ${active};
  CREATE INDEX IF NOT EXISTS managed_process_unfinished ON managed_process((${unfinished})) WHERE ${unfinished};
  CREATE INDEX IF NOT EXISTS managed_process_session ON managed_process(${session}, (${terminal}) DESC);
  CREATE INDEX IF NOT EXISTS managed_process_unfinished_session ON managed_process(${session}) WHERE ${unfinished};
  CREATE INDEX IF NOT EXISTS managed_process_unfinished_run ON managed_process(${run}) WHERE ${unfinished};
  CREATE INDEX IF NOT EXISTS managed_process_successful_exit ON managed_process(${session}) WHERE ${successful};`;

function scopedUnfinished(scope: ProcessScope, requiredOnly: boolean) {
  const bySession = scope.sessionId !== undefined;
  return { where: `${bySession ? session : run} = ? AND ${unfinished}${requiredOnly ? ` AND ${required}` : ''}`,
    id: bySession ? scope.sessionId : scope.runId };
}

export class SqliteManagedProcessRepository implements ManagedProcessRepository {
  constructor(private readonly database: DatabaseSync) {}
  transaction<T>(operation: () => T): T { return runInTransaction(this.database, operation); }
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
  page(offset: number, limit: number, activeOnly = false): ProcessPage {
    const where = activeOnly ? active : visible;
    const total = Number(this.database.prepare(`SELECT count(*) AS total FROM managed_process WHERE ${where}`).get()!.total);
    // 活跃索引只含在途行；否则 SQLite 可能为避免排序而倒扫整张历史表。
    const index = activeOnly ? 'managed_process_active' : 'managed_process_visible';
    const processes = offset >= total ? [] : this.database.prepare(`SELECT record_json FROM managed_process INDEXED BY ${index}
      WHERE ${where} ORDER BY ${activeOnly ? 'rowid DESC' : newestFirst} LIMIT ? OFFSET ?`)
      .all(limit, offset).map(row => this.decode(row).public);
    return { processes, total, nextOffset: limit >= 0 && offset + limit < total ? offset + limit : null };
  }
  forSession(sessionId: string): ManagedProcessRecord[] {
    return this.database.prepare(`SELECT record_json FROM managed_process WHERE ${session} = ? ORDER BY ${newestFirst}`)
      .all(sessionId).map(row => this.decode(row));
  }
  unfinished(scope: ProcessScope, requiredOnly = false): ManagedProcessRecord[] {
    const { where, id } = scopedUnfinished(scope, requiredOnly);
    return this.database.prepare(`SELECT record_json FROM managed_process WHERE ${where} ORDER BY rowid DESC`)
      .all(id).map(row => this.decode(row));
  }
  hasUnfinished(scope: ProcessScope, requiredOnly = false): boolean {
    const { where, id } = scopedUnfinished(scope, requiredOnly);
    return !!this.database.prepare(`SELECT 1 FROM managed_process WHERE ${where} LIMIT 1`).get(id);
  }
  hasSuccessfulExit(sessionId: string): boolean {
    return !!this.database.prepare(`SELECT 1 FROM managed_process WHERE ${session} = ? AND ${successful} LIMIT 1`).get(sessionId);
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
    return this.database.prepare(`SELECT record_json FROM managed_process INDEXED BY managed_process_unfinished WHERE ${unfinished} ORDER BY rowid DESC`).all().map(row => this.decode(row));
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
