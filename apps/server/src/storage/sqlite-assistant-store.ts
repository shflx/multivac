import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  AssistantCommandKind,
  AssistantCommandReceipt,
  AssistantCommandStatus,
  AssistantCommandTerminalOutcome,
  AssistantPageState,
  AssistantPublicEvent,
  CoordinatorSessionBinding,
} from '@multivac/contracts';
import {
  AssistantPageStateRevisionConflictError,
  type AssistantPageStateRepository,
  type AssistantSessionBindingRepository,
} from '../modules/sessions/assistant-session.js';
import {
  AssistantEventCursorExpiredError,
  type AppendAssistantPublicEventInput,
  type AssistantCommandEventMutation,
  type AssistantCommandRepository,
  type AssistantDispatchMode,
  type AssistantEventRepository,
  type AssistantProjectionMutation,
  type AssistantProjectionReceiptUpdate,
  type CreateAssistantCommandInput,
  type StoredAssistantCommandReceipt,
} from '../modules/sessions/assistant-turn.js';

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

interface CommandRow {
  command_id: string;
  assistant_id: string;
  kind: AssistantCommandKind;
  payload_fingerprint: string;
  dispatch_mode: AssistantDispatchMode | null;
  phase: Exclude<AssistantCommandStatus, 'unknown'>;
  terminal_outcome: AssistantCommandTerminalOutcome | null;
  error_code: string | null;
  error_message: string | null;
  pi_session_id: string | null;
  pi_entry_id: string | null;
  pi_turn_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  cursor: number;
  assistant_id: string;
  command_id: string | null;
  event_type: AssistantPublicEvent['type'];
  payload_json: string;
  occurred_at: string;
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
  `
    CREATE TABLE assistant_command_receipt (
      command_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('send', 'cancel')),
      payload_fingerprint TEXT NOT NULL,
      dispatch_mode TEXT CHECK (dispatch_mode IN ('prompt', 'steer', 'followUp', 'abort')),
      phase TEXT NOT NULL CHECK (phase IN ('accepted', 'handed_to_pi', 'running', 'terminal')),
      terminal_outcome TEXT CHECK (terminal_outcome IN ('accepted', 'succeeded', 'failed', 'cancelled', 'rejected')),
      error_code TEXT,
      error_message TEXT,
      pi_session_id TEXT,
      pi_entry_id TEXT,
      pi_turn_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX assistant_command_receipt_active_idx
      ON assistant_command_receipt (assistant_id, phase, updated_at);

    CREATE TABLE assistant_event_projection (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL UNIQUE,
      assistant_id TEXT NOT NULL,
      command_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE,
      FOREIGN KEY (command_id) REFERENCES assistant_command_receipt(command_id) ON DELETE SET NULL
    ) STRICT;

    CREATE INDEX assistant_event_projection_assistant_cursor_idx
      ON assistant_event_projection (assistant_id, cursor);
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

function commandFromRow(row: CommandRow): StoredAssistantCommandReceipt {
  return {
    commandId: row.command_id,
    assistantSessionId: row.assistant_id,
    kind: row.kind,
    payloadFingerprint: row.payload_fingerprint,
    dispatchMode: row.dispatch_mode,
    status: row.phase,
    terminalOutcome: row.terminal_outcome,
    error: row.error_code && row.error_message
      ? { code: row.error_code, message: row.error_message }
      : null,
    piSessionId: row.pi_session_id,
    piEntryId: row.pi_entry_id,
    piTurnRef: row.pi_turn_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): AssistantPublicEvent {
  return {
    cursor: String(row.cursor),
    eventId: `assistant-event:${row.cursor}`,
    assistantSessionId: row.assistant_id,
    commandId: row.command_id,
    type: row.event_type,
    data: JSON.parse(row.payload_json) as AssistantPublicEvent['data'],
    occurredAt: row.occurred_at,
  } as AssistantPublicEvent;
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
      throw new Error('Multivac binding 写入后未能读取。');
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

  getCommand(commandId: string): StoredAssistantCommandReceipt | undefined {
    const row = this.database.prepare(`
      SELECT * FROM assistant_command_receipt WHERE command_id = ?
    `).get(commandId) as unknown as CommandRow | undefined;
    return row ? commandFromRow(row) : undefined;
  }

  listNonTerminal(assistantSessionId: string): StoredAssistantCommandReceipt[] {
    const rows = this.database.prepare(`
      SELECT * FROM assistant_command_receipt
      WHERE assistant_id = ? AND phase != 'terminal'
      ORDER BY created_at, command_id
    `).all(assistantSessionId) as unknown as CommandRow[];
    return rows.map(commandFromRow);
  }

  createAccepted(input: CreateAssistantCommandInput): AssistantCommandEventMutation {
    return this.transaction(() => {
      const existing = this.getCommand(input.commandId);
      if (existing) return { receipt: existing, event: null };
      const now = this.now();
      this.database.prepare(`
        INSERT INTO assistant_command_receipt (
          command_id, assistant_id, kind, payload_fingerprint, dispatch_mode, phase,
          terminal_outcome, error_code, error_message, pi_session_id, pi_entry_id,
          pi_turn_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'accepted', NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
      `).run(
        input.commandId,
        input.assistantSessionId,
        input.kind,
        input.payloadFingerprint,
        input.piSessionId,
        now,
        now,
      );
      const event = this.appendEventRow({
        sourceKey: `command:${input.commandId}:accepted`,
        assistantSessionId: input.assistantSessionId,
        commandId: input.commandId,
        type: 'assistant.command.accepted',
        data: { kind: input.kind },
        occurredAt: now,
      });
      return { receipt: this.requireCommand(input.commandId), event };
    });
  }

  reject(commandId: string, error: { code: string; message: string }): AssistantCommandEventMutation {
    return this.transaction(() => {
      const current = this.requireCommand(commandId);
      if (current.status === 'terminal') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'terminal', terminal_outcome = 'rejected', error_code = ?, error_message = ?, updated_at = ?
        WHERE command_id = ? AND phase != 'terminal'
      `).run(error.code, error.message, now, commandId);
      const event = this.appendEventRow({
        sourceKey: `command:${commandId}:rejected`,
        assistantSessionId: current.assistantSessionId,
        commandId,
        type: 'assistant.command.rejected',
        data: { error },
        occurredAt: now,
      });
      return { receipt: this.requireCommand(commandId), event };
    });
  }

  markHandedToPi(
    commandId: string,
    dispatchMode: AssistantDispatchMode,
  ): AssistantCommandEventMutation {
    return this.transaction(() => {
      const current = this.requireCommand(commandId);
      if (current.status !== 'accepted') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'handed_to_pi', dispatch_mode = ?, updated_at = ?
        WHERE command_id = ? AND phase = 'accepted'
      `).run(dispatchMode, now, commandId);
      const event = this.appendEventRow({
        sourceKey: `command:${commandId}:handed`,
        assistantSessionId: current.assistantSessionId,
        commandId,
        type: 'assistant.command.handed_to_pi',
        data: { kind: current.kind, dispatchMode },
        occurredAt: now,
      });
      return { receipt: this.requireCommand(commandId), event };
    });
  }

  markRunning(commandId: string, piTurnRef: string | null): AssistantCommandEventMutation {
    return this.transaction(() => {
      const current = this.requireCommand(commandId);
      if (current.status === 'terminal') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'running', pi_turn_ref = COALESCE(pi_turn_ref, ?), updated_at = ?
        WHERE command_id = ? AND phase != 'terminal'
      `).run(piTurnRef, now, commandId);
      return { receipt: this.requireCommand(commandId), event: null };
    });
  }

  reconcile(
    commandId: string,
    terminalOutcome: AssistantCommandTerminalOutcome,
    error?: { code: string; message: string },
    piEntryId?: string | null,
  ): AssistantCommandEventMutation {
    return this.transaction(() => {
      const current = this.requireCommand(commandId);
      if (current.status === 'terminal') {
        if (piEntryId && !current.piEntryId) {
          this.database.prepare(`
            UPDATE assistant_command_receipt
            SET pi_entry_id = ?, updated_at = ?
            WHERE command_id = ? AND pi_entry_id IS NULL
          `).run(piEntryId, this.now(), commandId);
          return { receipt: this.requireCommand(commandId), event: null };
        }
        return { receipt: current, event: null };
      }
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'terminal', terminal_outcome = ?, error_code = ?, error_message = ?,
            pi_entry_id = COALESCE(?, pi_entry_id), updated_at = ?
        WHERE command_id = ? AND phase != 'terminal'
      `).run(
        terminalOutcome,
        error?.code ?? null,
        error?.message ?? null,
        piEntryId ?? null,
        now,
        commandId,
      );
      const receipt = this.requireCommand(commandId);
      const event = this.appendEventRow({
        sourceKey: `command:${commandId}:reconciled`,
        assistantSessionId: current.assistantSessionId,
        commandId,
        type: 'assistant.command.reconciled',
        data: {
          status: receipt.status,
          terminalOutcome: receipt.terminalOutcome,
          error: receipt.error,
        },
        occurredAt: now,
      });
      return { receipt, event };
    });
  }

  latestCursor(): string {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(cursor), 0) AS cursor FROM assistant_event_projection
    `).get() as unknown as { cursor: number };
    return String(row.cursor);
  }

  earliestCursor(): string {
    const row = this.database.prepare(`
      SELECT COALESCE(MIN(cursor), 0) AS cursor FROM assistant_event_projection
    `).get() as unknown as { cursor: number };
    return String(row.cursor);
  }

  append(input: AppendAssistantPublicEventInput): AssistantPublicEvent | null {
    return this.transaction(() => this.appendEventRow(input));
  }

  project(
    input: AppendAssistantPublicEventInput,
    receiptUpdate?: AssistantProjectionReceiptUpdate,
  ): AssistantProjectionMutation {
    return this.transaction(() => {
      const event = this.appendEventRow(input);
      if (!event || !receiptUpdate) {
        return {
          event,
          receipt: receiptUpdate ? this.getCommand(receiptUpdate.commandId) ?? null : null,
        };
      }

      const current = this.requireCommand(receiptUpdate.commandId);
      if (current.status !== 'terminal') {
        if (receiptUpdate.type === 'running') {
          this.database.prepare(`
            UPDATE assistant_command_receipt
            SET phase = 'running', pi_turn_ref = COALESCE(pi_turn_ref, ?), updated_at = ?
            WHERE command_id = ? AND phase != 'terminal'
          `).run(receiptUpdate.piTurnRef, input.occurredAt, receiptUpdate.commandId);
        } else {
          this.database.prepare(`
            UPDATE assistant_command_receipt
            SET phase = 'terminal', terminal_outcome = ?, error_code = NULL,
                error_message = NULL, updated_at = ?
            WHERE command_id = ? AND phase != 'terminal'
          `).run(receiptUpdate.terminalOutcome, input.occurredAt, receiptUpdate.commandId);
        }
      }

      return { event, receipt: this.requireCommand(receiptUpdate.commandId) };
    });
  }

  listAfter(cursor: string, limit = 500): AssistantPublicEvent[] {
    const after = Number(cursor);
    const latest = Number(this.latestCursor());
    const earliest = Number(this.earliestCursor());
    if (!Number.isSafeInteger(after) || after < 0 || after > latest || (earliest > 0 && after < earliest - 1)) {
      throw new AssistantEventCursorExpiredError();
    }
    const rows = this.database.prepare(`
      SELECT cursor, assistant_id, command_id, event_type, payload_json, occurred_at
      FROM assistant_event_projection
      WHERE cursor > ?
      ORDER BY cursor
      LIMIT ?
    `).all(after, limit) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  private appendEventRow(input: AppendAssistantPublicEventInput): AssistantPublicEvent | null {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_event_projection (
        source_key, assistant_id, command_id, event_type, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceKey,
      input.assistantSessionId,
      input.commandId,
      input.type,
      JSON.stringify(input.data),
      input.occurredAt,
    );
    if (result.changes === 0) return null;
    const row = this.database.prepare(`
      SELECT cursor, assistant_id, command_id, event_type, payload_json, occurred_at
      FROM assistant_event_projection WHERE source_key = ?
    `).get(input.sourceKey) as unknown as EventRow;
    return eventFromRow(row);
  }

  private requireCommand(commandId: string): StoredAssistantCommandReceipt {
    const receipt = this.getCommand(commandId);
    if (!receipt) throw new Error(`Multivac 命令不存在：${commandId}`);
    return receipt;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
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

export class SqliteAssistantCommandRepository implements AssistantCommandRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(commandId: string) { return this.store.getCommand(commandId); }
  listNonTerminal(assistantSessionId: string) { return this.store.listNonTerminal(assistantSessionId); }
  createAccepted(input: CreateAssistantCommandInput) { return this.store.createAccepted(input); }
  reject(commandId: string, error: { code: string; message: string }) {
    return this.store.reject(commandId, error);
  }
  markHandedToPi(commandId: string, dispatchMode: AssistantDispatchMode) {
    return this.store.markHandedToPi(commandId, dispatchMode);
  }
  markRunning(commandId: string, piTurnRef: string | null) {
    return this.store.markRunning(commandId, piTurnRef);
  }
  reconcile(
    commandId: string,
    terminalOutcome: AssistantCommandTerminalOutcome,
    error?: { code: string; message: string },
    piEntryId?: string | null,
  ) {
    return this.store.reconcile(commandId, terminalOutcome, error, piEntryId);
  }
}

export class SqliteAssistantEventRepository implements AssistantEventRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  latestCursor() { return this.store.latestCursor(); }
  earliestCursor() { return this.store.earliestCursor(); }
  append(input: AppendAssistantPublicEventInput) { return this.store.append(input); }
  project(input: AppendAssistantPublicEventInput, receiptUpdate?: AssistantProjectionReceiptUpdate) {
    return this.store.project(input, receiptUpdate);
  }
  listAfter(cursor: string, limit?: number) { return this.store.listAfter(cursor, limit); }
}
