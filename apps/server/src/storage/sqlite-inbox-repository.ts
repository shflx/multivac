import type { DatabaseSync } from 'node:sqlite';
import type { InboxState, UpdateInboxState, ExternalOperation } from '@multivac/contracts';
import { TaskServiceError } from '../application/task-service.js';

export const INBOX_MIGRATION = `
  CREATE TABLE IF NOT EXISTS inbox_state (request_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, seen INTEGER NOT NULL, draft TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS inbox_external (id TEXT PRIMARY KEY, record_json TEXT NOT NULL) STRICT;
`;

/** 查看与草稿是共享用户状态，不写入原业务请求的版本。 */
export class SqliteInboxRepository {
  constructor(private readonly db: DatabaseSync) {}
  operations(): ExternalOperation[] { return this.db.prepare('SELECT record_json FROM inbox_external ORDER BY id').all().map((row) => JSON.parse(String(row.record_json)) as ExternalOperation); }
  operation(id: string): ExternalOperation | null {
    const row = this.db.prepare('SELECT record_json FROM inbox_external WHERE id=?').get(id);
    return row ? JSON.parse(String(row.record_json)) as ExternalOperation : null;
  }
  saveOperation(operation: ExternalOperation): void { this.db.prepare('INSERT INTO inbox_external VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(operation.id, JSON.stringify(operation)); }
  get(id: string): InboxState {
    const row = this.db.prepare('SELECT revision,seen,draft FROM inbox_state WHERE request_id=?').get(id) as { revision: number; seen: number; draft: string } | undefined;
    return row ? { ...row, seen: Boolean(row.seen) } : { revision: 0, seen: false, draft: '' };
  }
  update(id: string, input: UpdateInboxState): InboxState {
    const current = this.get(id);
    if (input.revision !== current.revision) throw new TaskServiceError('TASK_CONFLICT', '另一窗口修改了草稿，请保留当前输入并重新核对。');
    const next = { revision: current.revision + 1, seen: current.seen || input.seen === true, draft: input.draft ?? current.draft };
    this.db.prepare('INSERT INTO inbox_state VALUES (?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET revision=excluded.revision,seen=excluded.seen,draft=excluded.draft').run(id, next.revision, Number(next.seen), next.draft);
    return next;
  }
}
