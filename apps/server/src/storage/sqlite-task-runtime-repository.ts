import type { DatabaseSync } from 'node:sqlite';
import type { TaskRuntimeRepository } from '../modules/tasks/task.js';

export const TASK_RUNTIME_MIGRATION = `
  CREATE TABLE IF NOT EXISTS task_runtime_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
  CREATE INDEX IF NOT EXISTS task_run_session ON task_run(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS task_run_directory_lease ON task_run(json_extract(record_json, '$.directory.path')) WHERE stop_confirmed=0 AND json_extract(record_json, '$.directory.path') IS NOT NULL;
`;
export interface TaskRuntimeOwner { ownerId: string; pid: number }
export class SqliteTaskRuntimeRepository implements TaskRuntimeRepository {
  constructor(private readonly database: DatabaseSync) {}
  owner(): TaskRuntimeOwner | null {
    const row = this.database.prepare('SELECT owner_id,pid FROM task_runtime_owner WHERE singleton=1').get() as { owner_id: string; pid: number } | undefined;
    return row ? { ownerId: row.owner_id, pid: row.pid } : null;
  }
  claim(ownerId: string, pid: number): void { this.database.prepare('INSERT INTO task_runtime_owner VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid').run(ownerId, pid); }
  release(ownerId: string): void { this.database.prepare('DELETE FROM task_runtime_owner WHERE owner_id=?').run(ownerId); }
}
