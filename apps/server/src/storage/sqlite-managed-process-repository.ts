import type { DatabaseSync } from 'node:sqlite';
import { ManagedProcessSchema, type ManagedProcess } from '@multivac/contracts';
import { Check } from 'typebox/value';

export interface ManagedProcessRecord {
  public: ManagedProcess; commandId: string; fingerprint: string; directory: string;
  token: string; pid: number | null; ownerId: string;
}
export const MANAGED_PROCESS_MIGRATION = `CREATE TABLE IF NOT EXISTS managed_process (
  process_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS managed_process_command (
  command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL
) STRICT;`;
export class SqliteManagedProcessRepository {
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
  saveCommand(id: string, key: string, result: ManagedProcess): void {
    this.database.prepare('INSERT INTO managed_process_command VALUES(?,?,?)').run(id, key, JSON.stringify(result));
  }
  all(): ManagedProcessRecord[] {
    return this.database.prepare('SELECT record_json FROM managed_process ORDER BY rowid DESC').all().map((row) => {
      const record = JSON.parse(String(row.record_json)) as ManagedProcessRecord;
      if (!Check(ManagedProcessSchema, record.public)) throw new Error('托管进程记录不符合契约。');
      return record;
    });
  }
  get(id: string): ManagedProcessRecord | undefined { return this.all().find((record) => record.public.processId === id); }
  save(record: ManagedProcessRecord): void {
    if (!Check(ManagedProcessSchema, record.public)) throw new Error('托管进程写入不符合契约。');
    this.database.prepare('INSERT INTO managed_process VALUES(?,?,?) ON CONFLICT(process_id) DO UPDATE SET record_json=excluded.record_json')
      .run(record.public.processId, record.commandId, JSON.stringify(record));
  }
}
