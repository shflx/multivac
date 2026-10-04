import type { DatabaseSync } from 'node:sqlite';
import { ManagedProcessSchema, type ManagedProcess } from '@multivac/contracts';
import { Check } from 'typebox/value';

export interface ManagedProcessRecord {
  public: ManagedProcess; commandId: string; fingerprint: string; directory: string;
  token: string; pid: number | null; ownerId: string;
}
export const MANAGED_PROCESS_MIGRATION = `CREATE TABLE IF NOT EXISTS managed_process (
  process_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
) STRICT;`;
export class SqliteManagedProcessRepository {
  constructor(private readonly database: DatabaseSync) {}
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
