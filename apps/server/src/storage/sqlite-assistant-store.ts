import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AssistantPageState, CoordinatorSessionBinding } from '@multivac/contracts';
import {
  AssistantPageStateRevisionConflictError,
  type AssistantPageStateRepository,
  type AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';

interface BindingRow {
  assistant_id: string;
  pi_session_id: string;
  pi_session_path: string;
  updated_at: string;
}

interface PageStateRow {
  draft: string;
  anchor_entry_id: string | null;
  anchor_offset_px: number;
  revision: number;
}

const MIGRATIONS = [
  `
    CREATE TABLE assistant_session_binding (
      assistant_id TEXT PRIMARY KEY,
      pi_session_id TEXT NOT NULL UNIQUE,
      pi_session_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE assistant_page_state (
      assistant_id TEXT PRIMARY KEY,
      draft TEXT NOT NULL,
      anchor_entry_id TEXT,
      anchor_offset_px REAL NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE
    ) STRICT;
  `,
] as const;

function bindingFromRow(row: BindingRow): CoordinatorSessionBinding {
  return {
    assistantSessionId: row.assistant_id,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    updatedAt: row.updated_at,
  };
}

function pageStateFromRow(row: PageStateRow | undefined): AssistantPageState {
  if (!row) {
    return { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 };
  }
  return {
    draft: row.draft,
    anchorEntryId: row.anchor_entry_id,
    anchorOffsetPx: row.anchor_offset_px,
    revision: row.revision,
  };
}

export interface SqliteAssistantStoreOptions {
  now?: () => string;
}

/** 同步 SQLite 只承担短查询和短事务，不包裹任何 Pi 或文件操作。 */
export class SqliteAssistantStore {
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath: string, options: SqliteAssistantStoreOptions = {}) {
    this.database = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  getBinding(assistantSessionId: string): CoordinatorSessionBinding | undefined {
    const row = this.database.prepare(`
      SELECT assistant_id, pi_session_id, pi_session_path, updated_at
      FROM assistant_session_binding
      WHERE assistant_id = ?
    `).get(assistantSessionId) as unknown as BindingRow | undefined;
    return row ? bindingFromRow(row) : undefined;
  }

  insertIfAbsent(binding: CoordinatorSessionBinding): {
    binding: CoordinatorSessionBinding;
    inserted: boolean;
  } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_session_binding (
        assistant_id, pi_session_id, pi_session_path, updated_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      binding.assistantSessionId,
      binding.piSessionId,
      binding.piSessionPath,
      binding.updatedAt,
    );
    const winner = this.getBinding(binding.assistantSessionId);
    if (!winner) {
      throw new Error('协调助手 binding 写入后未能读取。');
    }
    return { binding: winner, inserted: result.changes === 1 };
  }

  getPageState(assistantSessionId: string): AssistantPageState {
    const row = this.database.prepare(`
      SELECT draft, anchor_entry_id, anchor_offset_px, revision
      FROM assistant_page_state
      WHERE assistant_id = ?
    `).get(assistantSessionId) as unknown as PageStateRow | undefined;
    return pageStateFromRow(row);
  }

  save(assistantSessionId: string, state: AssistantPageState): AssistantPageState {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getPageState(assistantSessionId);
      if (current.revision !== state.revision) {
        throw new AssistantPageStateRevisionConflictError(current);
      }
      if (
        current.draft === state.draft &&
        current.anchorEntryId === state.anchorEntryId &&
        current.anchorOffsetPx === state.anchorOffsetPx
      ) {
        this.database.exec('COMMIT');
        return current;
      }

      const next: AssistantPageState = { ...state, revision: state.revision + 1 };
      const values: SQLInputValue[] = [
        assistantSessionId,
        next.draft,
        next.anchorEntryId,
        next.anchorOffsetPx,
        next.revision,
        this.now(),
      ];
      this.database.prepare(`
        INSERT INTO assistant_page_state (
          assistant_id, draft, anchor_entry_id, anchor_offset_px, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (assistant_id) DO UPDATE SET
          draft = excluded.draft,
          anchor_entry_id = excluded.anchor_entry_id,
          anchor_offset_px = excluded.anchor_offset_px,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(...values);
      this.database.exec('COMMIT');
      return next;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
      const row = this.database.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
      ).get() as unknown as { version: number };

      for (let index = row.version; index < MIGRATIONS.length; index += 1) {
        this.database.exec(MIGRATIONS[index]!);
        this.database.prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        ).run(index + 1, this.now());
      }
      this.database.exec('COMMIT');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // 保留触发 migration 失败的原始异常。
      }
      throw error;
    }
  }
}

export class SqliteAssistantBindingRepository implements AssistantSessionBindingRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(assistantSessionId: string): CoordinatorSessionBinding | undefined {
    return this.store.getBinding(assistantSessionId);
  }

  insertIfAbsent(binding: CoordinatorSessionBinding) {
    return this.store.insertIfAbsent(binding);
  }
}

export class SqliteAssistantPageStateRepository implements AssistantPageStateRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(assistantSessionId: string): AssistantPageState {
    return this.store.getPageState(assistantSessionId);
  }

  save(assistantSessionId: string, state: AssistantPageState): AssistantPageState {
    return this.store.save(assistantSessionId, state);
  }
}
