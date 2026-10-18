import type { DatabaseSync } from 'node:sqlite';
import type {
  NewTempDirectoryCleanupPlan,
  TempCleanupReason,
  TempDirectoryCleanupPlan,
  TempDirectoryCleanupRepository,
} from '../modules/sessions/temp-directory-cleanup.js';

interface TempDirectoryCleanupRow {
  path: string;
  directory_kind: 'session-temp';
  reason: TempCleanupReason;
  session_id: string;
  since: string;
  trashed_at: string | null;
  trash_path: string | null;
}

function cleanupPlanFromRow(row: TempDirectoryCleanupRow): TempDirectoryCleanupPlan {
  return {
    path: row.path,
    directoryKind: row.directory_kind,
    reason: row.reason,
    sessionId: row.session_id,
    since: row.since,
    trashedAt: row.trashed_at,
    trashPath: row.trash_path,
  };
}

/**
 * 会话临时目录清理计划的 SQLite 实现：登记、移入回收站与取消。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteTempDirectoryCleanupRepository implements TempDirectoryCleanupRepository {
  constructor(private readonly database: DatabaseSync) {}

  schedule(plan: NewTempDirectoryCleanupPlan): void {
    this.database.prepare(`
      INSERT INTO temp_directory_cleanup (path, directory_kind, reason, session_id, since, trashed_at, trash_path)
      VALUES (?, 'session-temp', ?, ?, ?, NULL, NULL)
      ON CONFLICT (path) DO UPDATE SET
        reason = excluded.reason, session_id = excluded.session_id, since = excluded.since,
        trashed_at = NULL, trash_path = NULL
    `).run(plan.path, plan.reason, plan.sessionId, plan.since);
  }

  get(path: string): TempDirectoryCleanupPlan | undefined {
    const row = this.database.prepare('SELECT * FROM temp_directory_cleanup WHERE path = ?')
      .get(path) as unknown as TempDirectoryCleanupRow | undefined;
    return row ? cleanupPlanFromRow(row) : undefined;
  }

  listPending(): TempDirectoryCleanupPlan[] {
    const rows = this.database.prepare(`
      SELECT * FROM temp_directory_cleanup WHERE trashed_at IS NULL ORDER BY since, path
    `).all() as unknown as TempDirectoryCleanupRow[];
    return rows.map(cleanupPlanFromRow);
  }

  markTrashed(path: string, trashedAt: string, trashPath: string): void {
    this.database.prepare('UPDATE temp_directory_cleanup SET trashed_at = ?, trash_path = ? WHERE path = ?')
      .run(trashedAt, trashPath, path);
  }

  remove(path: string): void {
    this.database.prepare('DELETE FROM temp_directory_cleanup WHERE path = ?').run(path);
  }

  clearForTest(): void {
    this.database.exec('DELETE FROM temp_directory_cleanup');
  }
}
