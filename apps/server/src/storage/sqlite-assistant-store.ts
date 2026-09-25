import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SessionSelectionRepository, StoredSessionSelection, StoredSelectionCommand } from '../modules/sessions/session-model-selection.js';
import type {
  NewSessionRecord,
  SessionOrigin,
  SessionRecord,
  SessionRegistryRepository,
  WorkspaceSceneRepository,
} from '../modules/sessions/session-registry.js';
import type {
  AssistantCommandKind,
  AssistantCommandReceipt,
  AssistantCommandStatus,
  AssistantCommandTerminalOutcome,
  AssistantPageState,
  AssistantPublicEvent,
  AssistantQuote,
  CoordinatorSessionBinding,
  WorkspaceSceneState,
  WorkspaceSessionKind,
} from '@multivac/contracts';
import {
  AssistantQuoteSchema,
  DEFAULT_WORKSPACE_ID,
  GLOBAL_ASSISTANT_SESSION_ID,
  truncateAssistantThinkingDelta,
  truncateAssistantThinkingTrace,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
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
  type RunTraceProjection,
  type ToolExecutionProjection,
  type AssistantCommandAnchor,
} from '../modules/sessions/assistant-turn.js';

interface BindingRow {
  assistant_id: string;
  pi_session_id: string;
  pi_session_path: string;
  updated_at: string;
  model_provider: string | null;
  model_id: string | null;
  model_protocol: string | null;
  model_endpoint: string | null;
  model_resolved_endpoint: string | null;
  model_profile_id: string | null;
  model_source: 'base' | 'controlled' | null;
  model_endpoint_mode: 'fixed' | 'pi-native-dynamic' | null;
}

interface SessionRow {
  session_id: string;
  title: string;
  kind: WorkspaceSessionKind;
  workspace_id: string;
  created_at: string;
  archived_at: string | null;
  parent_session_id: string | null;
  origin_json: string | null;
  pi_session_path: string | null;
}

interface PageStateRow {
  draft: string;
  anchor_entry_id: string | null;
  anchor_offset_px: number;
  quote_json: string | null;
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

interface ToolExecutionRow {
  command_id: string | null;
  tool_call_id: string;
  cursor: number;
  tool_name: string;
  started_at: string;
  ended_at: string | null;
  is_error: number | null;
  input_text: string | null;
  input_truncated: number | null;
}

interface RunTraceEventRow extends EventRow {}

interface MutableRunTraceProjection extends RunTraceProjection {
  thinkingText: string;
}

/** 工具记录只读取输入；旧投影缺少字段时按空处理，不读取输出正文。 */
const TOOL_EXECUTION_SELECT = `
  command_id AS command_id,
  json_extract(payload_json, '$.toolCallId') AS tool_call_id,
  MAX(cursor) AS cursor,
  MAX(json_extract(payload_json, '$.toolName')) AS tool_name,
  MIN(occurred_at) AS started_at,
  CASE WHEN SUM(event_type = 'assistant.tool.ended') > 0 THEN MAX(occurred_at) END AS ended_at,
  CASE WHEN SUM(event_type = 'assistant.tool.ended') > 0 THEN MAX(json_extract(payload_json, '$.isError')) END AS is_error,
  MAX(CASE WHEN event_type = 'assistant.tool.started'
    THEN json_extract(payload_json, '$.inputText') END) AS input_text,
  MAX(CASE WHEN event_type = 'assistant.tool.started'
    THEN json_extract(payload_json, '$.inputTruncated') END) AS input_truncated
`;

function toolExecutionFromRow(row: ToolExecutionRow): ToolExecutionProjection {
  return {
    commandId: row.command_id,
    toolCallId: row.tool_call_id,
    cursor: String(row.cursor),
    toolName: row.tool_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isError: row.is_error === 1,
    inputText: row.input_text,
    inputTruncated: row.input_truncated === 1,
  };
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
  `
    ALTER TABLE assistant_session_binding ADD COLUMN model_provider TEXT;
    ALTER TABLE assistant_session_binding ADD COLUMN model_id TEXT;
    ALTER TABLE assistant_session_binding ADD COLUMN model_protocol TEXT;
    ALTER TABLE assistant_session_binding ADD COLUMN model_endpoint TEXT;
    ALTER TABLE assistant_session_binding ADD COLUMN model_resolved_endpoint TEXT;
    ALTER TABLE assistant_session_binding ADD COLUMN model_profile_id TEXT;
  `,
  `
    ALTER TABLE assistant_session_binding ADD COLUMN model_source TEXT
      CHECK (model_source IN ('base', 'controlled'));
    UPDATE assistant_session_binding
      SET model_source = CASE WHEN model_profile_id IS NOT NULL THEN 'controlled' ELSE 'base' END
      WHERE model_provider IS NOT NULL AND model_id IS NOT NULL;
  `,
  `
    ALTER TABLE assistant_session_binding ADD COLUMN model_endpoint_mode TEXT
      CHECK (model_endpoint_mode IN ('fixed', 'pi-native-dynamic'));
  `,
  `
    CREATE TABLE assistant_model_selection (
      assistant_id TEXT PRIMARY KEY, selection_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assistant_model_command (
      command_id TEXT PRIMARY KEY, command_json TEXT NOT NULL
    ) STRICT;
  `,
  // 工具事件正文清理在同一事务内由 TypeScript 完成，以 UTF-8 字节为截断单位。
  `SELECT 1;`,
  `ALTER TABLE assistant_page_state ADD COLUMN quote_json TEXT;`,
  // 会话注册表：全局协调会话作为一条 coordinator 记录迁入，已有页面现场、回执、事件与选模
  // 本就按 assistant_id 保存，天然归属该记录。语句保持幂等，回退版本号后重放不会失败。
  `
    CREATE TABLE IF NOT EXISTS assistant_session_registry (
      session_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('coordinator', 'work')),
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      archived_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assistant_session_registry_workspace_idx
      ON assistant_session_registry (workspace_id, kind, archived_at, created_at);

    INSERT OR IGNORE INTO assistant_session_registry (session_id, title, kind, workspace_id, created_at, archived_at)
    VALUES (
      '${GLOBAL_ASSISTANT_SESSION_ID}', 'Multivac', 'coordinator', '${DEFAULT_WORKSPACE_ID}',
      COALESCE(
        (SELECT updated_at FROM assistant_session_binding WHERE assistant_id = '${GLOBAL_ASSISTANT_SESSION_ID}'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      NULL
    );
  `,
  // 工作区现场按工作区 id 保存；内容由应用层校验并在读取时剔除已归档会话。
  `
    CREATE TABLE IF NOT EXISTS workspace_scene (
      workspace_id TEXT PRIMARY KEY,
      scene_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `,
  // 注册表的栈式深入字段（父会话与来源引用）由 TypeScript 按列是否存在补充，保持重放幂等。
  `SELECT 1;`,
] as const;

/** 工具正文清理绑定到它所属的那次迁移，后续新增迁移不会重复或错位执行。 */
const TOOL_PAYLOAD_CLEANUP_MIGRATION_INDEX = 6;
/** 会话注册表补充父会话与来源引用列的迁移。 */
const SESSION_PARENT_MIGRATION_INDEX = 10;

const SESSION_SELECT = `
  SELECT r.session_id, r.title, r.kind, r.workspace_id, r.created_at, r.archived_at,
         r.parent_session_id, r.origin_json,
         b.pi_session_path AS pi_session_path
  FROM assistant_session_registry r
  LEFT JOIN assistant_session_binding b ON b.assistant_id = r.session_id
`;

/** 来源引用损坏时视为没有来源，不阻断会话读取。 */
function originFromColumn(value: string | null): SessionOrigin | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SessionOrigin>;
    if (typeof parsed.text !== 'string' || !parsed.text ||
        typeof parsed.sourcePiEntryId !== 'string' ||
        (parsed.sourceRole !== 'user' && parsed.sourceRole !== 'assistant') ||
        typeof parsed.parentTitle !== 'string' || typeof parsed.parentExcerpt !== 'string') return null;
    return parsed as SessionOrigin;
  } catch {
    return null;
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  const origin = originFromColumn(row.origin_json);
  return {
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    parentSessionId: row.parent_session_id,
    originText: origin?.text ?? null,
    piSessionPath: row.pi_session_path,
    origin,
  };
}

function bindingFromRow(row: BindingRow): CoordinatorSessionBinding {
  return {
    assistantSessionId: row.assistant_id,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    updatedAt: row.updated_at,
    ...(row.model_provider && row.model_id
      ? { modelProvider: row.model_provider, modelId: row.model_id }
      : {}),
    ...(row.model_protocol
      ? { modelProtocol: row.model_protocol as NonNullable<CoordinatorSessionBinding['modelProtocol']> }
      : {}),
    ...(row.model_protocol ? { modelEndpoint: row.model_endpoint } : {}),
    ...(row.model_resolved_endpoint || row.model_endpoint_mode === 'pi-native-dynamic'
      ? { modelResolvedEndpoint: row.model_resolved_endpoint } : {}),
    ...(row.model_profile_id ? { modelProfileId: row.model_profile_id } : {}),
    ...(row.model_source ? { modelSource: row.model_source } : {}),
    ...(row.model_endpoint_mode ? { modelEndpointMode: row.model_endpoint_mode } : {}),
  };
}

/** 旧记录没有 quote 列，损坏或不符合契约的内容同样按空引用读取，不阻断现场恢复。 */
function quoteFromColumn(value: string | null): AssistantQuote | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Check(AssistantQuoteSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameQuote(left: AssistantQuote | null, right: AssistantQuote | null): boolean {
  if (left === null || right === null) return left === right;
  return left.sourcePiSessionId === right.sourcePiSessionId &&
    left.sourcePiEntryId === right.sourcePiEntryId &&
    left.sourceRole === right.sourceRole &&
    left.text === right.text &&
    left.sourceSessionId === right.sourceSessionId &&
    left.sourceTitle === right.sourceTitle;
}

function pageStateFromRow(row: PageStateRow | undefined): AssistantPageState {
  if (!row) {
    return { draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0 };
  }
  return {
    draft: row.draft,
    anchorEntryId: row.anchor_entry_id,
    anchorOffsetPx: row.anchor_offset_px,
    quote: quoteFromColumn(row.quote_json),
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

function publicEventData(type: AssistantPublicEvent['type'], data: AssistantPublicEvent['data']): AssistantPublicEvent['data'] {
  if (type === 'assistant.tool.started') {
    const started = data as Extract<AssistantPublicEvent, { type: 'assistant.tool.started' }>['data'];
    const input = truncateAssistantToolInput(typeof started.inputText === 'string' ? started.inputText : '');
    return {
      toolCallId: started.toolCallId,
      toolName: started.toolName,
      inputText: input.text,
      inputTruncated: started.inputTruncated === true || input.truncated,
    };
  }
  if (type === 'assistant.tool.ended') {
    const ended = data as Extract<AssistantPublicEvent, { type: 'assistant.tool.ended' }>['data'];
    return { toolCallId: ended.toolCallId, toolName: ended.toolName, isError: ended.isError };
  }
  if (type === 'assistant.thinking.delta') {
    const thinking = data as Extract<AssistantPublicEvent, { type: 'assistant.thinking.delta' }>['data'];
    const delta = truncateAssistantThinkingDelta(typeof thinking.delta === 'string' ? thinking.delta : '');
    return {
      piSessionId: thinking.piSessionId,
      messageId: thinking.messageId,
      delta: delta.text,
      deltaTruncated: thinking.deltaTruncated === true || delta.truncated,
    };
  }
  return data;
}

function eventFromRow(row: EventRow): AssistantPublicEvent {
  return {
    cursor: String(row.cursor),
    eventId: `assistant-event:${row.cursor}`,
    assistantSessionId: row.assistant_id,
    commandId: row.command_id,
    type: row.event_type,
    data: publicEventData(row.event_type, JSON.parse(row.payload_json) as AssistantPublicEvent['data']),
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

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.database.prepare(`${SESSION_SELECT} WHERE r.session_id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  listSessions(workspaceId: string, kind: WorkspaceSessionKind, includeArchived = false): SessionRecord[] {
    const rows = this.database.prepare(`${SESSION_SELECT}
      WHERE r.workspace_id = ? AND r.kind = ? AND (? = 1 OR r.archived_at IS NULL)
      ORDER BY r.created_at, r.session_id
    `).all(workspaceId, kind, includeArchived ? 1 : 0) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  insertSessionIfAbsent(record: NewSessionRecord): { record: SessionRecord; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_session_registry
        (session_id, title, kind, workspace_id, created_at, archived_at, parent_session_id, origin_json)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      record.sessionId, record.title, record.kind, record.workspaceId, record.createdAt,
      record.parentSessionId ?? null, record.origin ? JSON.stringify(record.origin) : null,
    );
    const winner = this.getSession(record.sessionId);
    if (!winner) throw new Error('Multivac 会话注册表写入后未能读取。');
    return { record: winner, inserted: result.changes === 1 };
  }

  renameSession(sessionId: string, title: string): SessionRecord | undefined {
    this.database.prepare('UPDATE assistant_session_registry SET title = ? WHERE session_id = ?')
      .run(title, sessionId);
    return this.getSession(sessionId);
  }

  archiveSession(sessionId: string, archivedAt: string): SessionRecord | undefined {
    this.database.prepare(`
      UPDATE assistant_session_registry SET archived_at = COALESCE(archived_at, ?) WHERE session_id = ?
    `).run(archivedAt, sessionId);
    return this.getSession(sessionId);
  }

  deleteSessionIfUnbound(sessionId: string): boolean {
    const result = this.database.prepare(`
      DELETE FROM assistant_session_registry
      WHERE session_id = ? AND NOT EXISTS (
        SELECT 1 FROM assistant_session_binding WHERE assistant_id = assistant_session_registry.session_id
      )
    `).run(sessionId);
    return result.changes === 1;
  }

  getWorkspaceScene(workspaceId: string): unknown {
    const row = this.database.prepare('SELECT scene_json FROM workspace_scene WHERE workspace_id = ?')
      .get(workspaceId) as { scene_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.scene_json) as unknown;
    } catch {
      return undefined;
    }
  }

  saveWorkspaceScene(workspaceId: string, scene: WorkspaceSceneState): void {
    this.database.prepare(`
      INSERT INTO workspace_scene (workspace_id, scene_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET scene_json = excluded.scene_json, updated_at = excluded.updated_at
    `).run(workspaceId, JSON.stringify(scene), this.now());
  }

  getSelection(sessionId: string): StoredSessionSelection | undefined {
    const row = this.database.prepare('SELECT selection_json FROM assistant_model_selection WHERE assistant_id = ?')
      .get(sessionId) as { selection_json: string } | undefined;
    return row ? JSON.parse(row.selection_json) as StoredSessionSelection : undefined;
  }

  saveSelection(selection: StoredSessionSelection): void {
    this.database.prepare('INSERT INTO assistant_model_selection VALUES (?, ?) ON CONFLICT(assistant_id) DO UPDATE SET selection_json = excluded.selection_json')
      .run(selection.sessionId, JSON.stringify(selection));
  }

  getSelectionCommand(commandId: string): StoredSelectionCommand | undefined {
    const row = this.database.prepare('SELECT command_json FROM assistant_model_command WHERE command_id = ?')
      .get(commandId) as { command_json: string } | undefined;
    return row ? JSON.parse(row.command_json) as StoredSelectionCommand : undefined;
  }

  beginSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void {
    this.transaction(() => {
      this.database.prepare('INSERT INTO assistant_model_command VALUES (?, ?)').run(command.commandId, JSON.stringify(command));
      this.saveSelection(selection);
    });
  }

  finishSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void {
    this.transaction(() => {
      this.saveSelection(selection);
      if (!selection.pending) {
        const model = selection.model;
        this.database.prepare(`UPDATE assistant_session_binding SET
          model_provider = ?, model_id = ?, model_protocol = ?, model_endpoint = ?,
          model_resolved_endpoint = ?, model_profile_id = ?, model_source = ?, model_endpoint_mode = ?, updated_at = ?
          WHERE assistant_id = ? AND pi_session_id = ? AND pi_session_path = ?`)
          .run(model.provider, model.modelId, model.protocol ?? null, model.endpoint ?? null,
            model.resolvedEndpoint ?? null, model.profileId ?? null, model.source ?? 'base', model.endpointMode ?? null,
            this.now(), selection.sessionId, selection.piSessionId, selection.piSessionPath);
      }
      this.database.prepare('UPDATE assistant_model_command SET command_json = ? WHERE command_id = ?')
        .run(JSON.stringify(command), command.commandId);
    });
  }

  getBinding(assistantSessionId: string): CoordinatorSessionBinding | undefined {
    const row = this.database.prepare(`
      SELECT assistant_id, pi_session_id, pi_session_path, updated_at,
             model_provider, model_id, model_protocol, model_endpoint,
             model_resolved_endpoint, model_profile_id, model_source, model_endpoint_mode
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
        assistant_id, pi_session_id, pi_session_path, updated_at,
        model_provider, model_id, model_protocol, model_endpoint,
        model_resolved_endpoint, model_profile_id, model_source, model_endpoint_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      binding.assistantSessionId,
      binding.piSessionId,
      binding.piSessionPath,
      binding.updatedAt,
      binding.modelProvider ?? null,
      binding.modelId ?? null,
      binding.modelProtocol ?? null,
      binding.modelEndpoint ?? null,
      binding.modelResolvedEndpoint ?? null,
      binding.modelProfileId ?? null,
      binding.modelSource ?? null,
      binding.modelEndpointMode ?? null,
    );
    const winner = this.getBinding(binding.assistantSessionId);
    if (!winner) {
      throw new Error('Multivac binding 写入后未能读取。');
    }
    return { binding: winner, inserted: result.changes === 1 };
  }

  getPageState(assistantSessionId: string): AssistantPageState {
    const row = this.database.prepare(`
      SELECT draft, anchor_entry_id, anchor_offset_px, quote_json, revision
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
        current.anchorOffsetPx === state.anchorOffsetPx &&
        sameQuote(current.quote, state.quote)
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
        next.quote ? JSON.stringify(next.quote) : null,
        next.revision,
        this.now(),
      ];
      this.database.prepare(`
        INSERT INTO assistant_page_state (
          assistant_id, draft, anchor_entry_id, anchor_offset_px, quote_json, revision, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (assistant_id) DO UPDATE SET
          draft = excluded.draft,
          anchor_entry_id = excluded.anchor_entry_id,
          anchor_offset_px = excluded.anchor_offset_px,
          quote_json = excluded.quote_json,
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

  /** 只返回带 Pi entry 锚点的命令，按创建顺序；供前端把工具记录放回所属 Turn。 */
  listCommandAnchors(assistantSessionId: string): AssistantCommandAnchor[] {
    const rows = this.database.prepare(`
      SELECT command_id, pi_entry_id FROM assistant_command_receipt
      WHERE assistant_id = ? AND pi_entry_id IS NOT NULL
      ORDER BY created_at, command_id
    `).all(assistantSessionId) as unknown as { command_id: string; pi_entry_id: string }[];
    return rows.map((row) => ({ commandId: row.command_id, piEntryId: row.pi_entry_id }));
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

  /** 按命令排除已终结正文；与 cursor/Pi 历史的同步读取间不让出事件循环。 */
  streamingEvents(assistantSessionId: string): AssistantPublicEvent[] {
    const rows = this.database.prepare(`
      SELECT d.cursor, d.assistant_id, d.command_id, d.event_type, d.payload_json, d.occurred_at
      FROM assistant_event_projection d
      WHERE d.assistant_id = ? AND d.event_type = 'assistant.message.delta'
        AND NOT EXISTS (SELECT 1 FROM assistant_event_projection t
          WHERE t.assistant_id = d.assistant_id AND t.command_id IS d.command_id
            AND t.cursor > d.cursor AND t.event_type IN
            ('assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled'))
        AND NOT EXISTS (SELECT 1 FROM assistant_command_receipt r
          WHERE r.command_id = d.command_id AND r.phase = 'terminal'
            AND r.error_code = 'COMMAND_INTERRUPTED')
      ORDER BY d.cursor
    `).all(assistantSessionId) as unknown as EventRow[];
    return rows.map(eventFromRow);
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

  listAfter(cursor: string, limit = 500, assistantSessionId?: string): AssistantPublicEvent[] {
    const after = Number(cursor);
    const latest = Number(this.latestCursor());
    const earliest = Number(this.earliestCursor());
    if (!Number.isSafeInteger(after) || after < 0 || after > latest || (earliest > 0 && after < earliest - 1)) {
      throw new AssistantEventCursorExpiredError();
    }
    const rows = (assistantSessionId === undefined
      ? this.database.prepare(`
          SELECT cursor, assistant_id, command_id, event_type, payload_json, occurred_at
          FROM assistant_event_projection
          WHERE cursor > ?
          ORDER BY cursor
          LIMIT ?
        `).all(after, limit)
      : this.database.prepare(`
          SELECT cursor, assistant_id, command_id, event_type, payload_json, occurred_at
          FROM assistant_event_projection
          WHERE assistant_id = ? AND cursor > ?
          ORDER BY cursor
          LIMIT ?
        `).all(assistantSessionId, after, limit)) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  /** 截取 before 之前最近的 limit 条工具调用，返回时按 cursor 升序。 */
  toolExecutionProjections(
    assistantSessionId: string,
    limit: number,
    before?: string,
  ): ToolExecutionProjection[] {
    const beforeCursor = before === undefined ? undefined : Number(before);
    if (beforeCursor !== undefined && (!Number.isSafeInteger(beforeCursor) || beforeCursor < 0)) {
      return [];
    }
    const having = beforeCursor === undefined ? '' : 'HAVING MAX(cursor) < ?';
    const parameters: SQLInputValue[] = beforeCursor === undefined
      ? [assistantSessionId, limit]
      : [assistantSessionId, beforeCursor, limit];
    const rows = this.database.prepare(`
      SELECT ${TOOL_EXECUTION_SELECT}
      FROM assistant_event_projection
      WHERE assistant_id = ? AND tool_call_id IS NOT NULL
      GROUP BY tool_call_id
      ${having}
      ORDER BY cursor DESC
      LIMIT ?
    `).all(...parameters) as unknown as ToolExecutionRow[];
    return rows.map(toolExecutionFromRow).reverse();
  }

  toolExecutionProjection(
    assistantSessionId: string,
    toolCallId: string,
  ): ToolExecutionProjection | undefined {
    const rows = this.database.prepare(`
      SELECT ${TOOL_EXECUTION_SELECT}
      FROM assistant_event_projection
      WHERE assistant_id = ? AND tool_call_id = ?
      GROUP BY tool_call_id
    `).all(assistantSessionId, toolCallId) as unknown as ToolExecutionRow[];
    const row = rows[0];
    return row ? toolExecutionFromRow(row) : undefined;
  }

  runTraceProjections(assistantSessionId: string, limit: number): RunTraceProjection[] {
    const rows = this.database.prepare(`
      WITH recent_commands AS (
        SELECT command_id, MAX(cursor) AS latest_cursor
        FROM assistant_event_projection
        WHERE assistant_id = ? AND command_id IS NOT NULL AND event_type IN (
          'assistant.run.processing', 'assistant.thinking.delta',
          'assistant.tool.started',
          'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled'
        )
        GROUP BY command_id
        ORDER BY latest_cursor DESC
        LIMIT ?
      )
      SELECT e.cursor, e.assistant_id, e.command_id, e.event_type, e.payload_json, e.occurred_at
      FROM assistant_event_projection e
      JOIN recent_commands r ON r.command_id = e.command_id
      WHERE e.assistant_id = ? AND e.event_type IN (
        'assistant.run.processing', 'assistant.thinking.delta',
        'assistant.tool.started',
        'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled'
      )
      ORDER BY e.cursor
    `).all(assistantSessionId, limit, assistantSessionId) as unknown as RunTraceEventRow[];
    const traces = new Map<string, MutableRunTraceProjection>();

    for (const row of rows) {
      if (!row.command_id) continue;
      const event = eventFromRow(row);
      const current = traces.get(row.command_id) ?? {
        commandId: row.command_id,
        cursor: String(row.cursor),
        status: 'running' as const,
        entries: [],
        thinkingText: '',
        thinkingTruncated: false,
        startedAt: row.occurred_at,
        endedAt: null,
      };
      current.cursor = String(row.cursor);
      if (event.type === 'assistant.thinking.delta') {
        const thinking = truncateAssistantThinkingTrace(current.thinkingText + event.data.delta);
        const appended = thinking.text.slice(current.thinkingText.length);
        const truncated = event.data.deltaTruncated || thinking.truncated;
        const previous = current.entries.at(-1);
        if (appended) {
          if (previous?.kind === 'thinking') {
            previous.cursor = String(row.cursor);
            previous.text += appended;
            previous.truncated = previous.truncated || truncated;
          } else {
            current.entries.push({
              kind: 'thinking', cursor: String(row.cursor), text: appended, truncated,
            });
          }
        } else if (truncated && previous?.kind === 'thinking') {
          previous.truncated = true;
        }
        current.thinkingText = thinking.text;
        current.thinkingTruncated = current.thinkingTruncated || truncated;
      } else if (event.type === 'assistant.tool.started') {
        if (!current.entries.some((entry) =>
          entry.kind === 'tool' && entry.toolCallId === event.data.toolCallId)) {
          current.entries.push({
            kind: 'tool', cursor: String(row.cursor), toolCallId: event.data.toolCallId,
          });
        }
      } else if (event.type === 'assistant.run.succeeded') {
        current.status = 'succeeded';
        current.endedAt = row.occurred_at;
      } else if (event.type === 'assistant.run.failed') {
        current.status = 'failed';
        current.endedAt = row.occurred_at;
      } else if (event.type === 'assistant.run.cancelled') {
        current.status = 'cancelled';
        current.endedAt = row.occurred_at;
      }
      traces.set(row.command_id, current);
    }

    return [...traces.values()]
      .map(({ thinkingText: _thinkingText, ...trace }) => trace)
      .sort((left, right) => Number(left.cursor) - Number(right.cursor));
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
      JSON.stringify(publicEventData(input.type, input.data)),
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
        if (index === SESSION_PARENT_MIGRATION_INDEX) {
          const columns = new Set((this.database.prepare(
            'SELECT name FROM pragma_table_info(\'assistant_session_registry\')',
          ).all() as Array<{ name: string }>).map((column) => column.name));
          if (!columns.has('parent_session_id')) {
            this.database.exec('ALTER TABLE assistant_session_registry ADD COLUMN parent_session_id TEXT;');
          }
          if (!columns.has('origin_json')) {
            this.database.exec('ALTER TABLE assistant_session_registry ADD COLUMN origin_json TEXT;');
          }
        }
        if (index === TOOL_PAYLOAD_CLEANUP_MIGRATION_INDEX) {
          const hasEvents = this.database.prepare(`
            SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'assistant_event_projection'
          `).get();
          if (hasEvents) {
            const rows = this.database.prepare(`
              SELECT cursor, event_type, payload_json FROM assistant_event_projection
              WHERE event_type IN ('assistant.tool.started', 'assistant.tool.ended')
            `).all() as unknown as Array<Pick<EventRow, 'cursor' | 'event_type' | 'payload_json'>>;
            const update = this.database.prepare(
              'UPDATE assistant_event_projection SET payload_json = ? WHERE cursor = ?',
            );
            for (const event of rows) {
              const data = publicEventData(event.event_type, JSON.parse(event.payload_json) as AssistantPublicEvent['data']);
              update.run(JSON.stringify(data), event.cursor);
            }
          }
        }
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

export class SqliteSessionRegistryRepository implements SessionRegistryRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  get(sessionId: string) { return this.store.getSession(sessionId); }
  list(workspaceId: string, kind: WorkspaceSessionKind, options: { includeArchived?: boolean } = {}) {
    return this.store.listSessions(workspaceId, kind, options.includeArchived ?? false);
  }
  insertIfAbsent(record: NewSessionRecord) { return this.store.insertSessionIfAbsent(record); }
  rename(sessionId: string, title: string) { return this.store.renameSession(sessionId, title); }
  archive(sessionId: string, archivedAt: string) { return this.store.archiveSession(sessionId, archivedAt); }
  deleteIfUnbound(sessionId: string) { return this.store.deleteSessionIfUnbound(sessionId); }
}

export class SqliteWorkspaceSceneRepository implements WorkspaceSceneRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  get(workspaceId: string) { return this.store.getWorkspaceScene(workspaceId); }
  save(workspaceId: string, scene: WorkspaceSceneState) { this.store.saveWorkspaceScene(workspaceId, scene); }
}

export class SqliteSessionSelectionRepository implements SessionSelectionRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  getSelection(id: string) { return this.store.getSelection(id); }
  saveSelection(selection: StoredSessionSelection) { this.store.saveSelection(selection); }
  getSelectionCommand(id: string) { return this.store.getSelectionCommand(id); }
  beginSelection(selection: StoredSessionSelection, command: StoredSelectionCommand) { this.store.beginSelection(selection, command); }
  finishSelection(selection: StoredSessionSelection, command: StoredSelectionCommand) { this.store.finishSelection(selection, command); }
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
  listCommandAnchors(assistantSessionId: string) { return this.store.listCommandAnchors(assistantSessionId); }
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
  streamingEvents(assistantSessionId: string) { return this.store.streamingEvents(assistantSessionId); }
  earliestCursor() { return this.store.earliestCursor(); }
  append(input: AppendAssistantPublicEventInput) { return this.store.append(input); }
  project(input: AppendAssistantPublicEventInput, receiptUpdate?: AssistantProjectionReceiptUpdate) {
    return this.store.project(input, receiptUpdate);
  }
  listAfter(cursor: string, limit?: number, assistantSessionId?: string) {
    return this.store.listAfter(cursor, limit, assistantSessionId);
  }
  toolExecutionProjections(assistantSessionId: string, limit: number, before?: string) {
    return this.store.toolExecutionProjections(assistantSessionId, limit, before);
  }
  toolExecutionProjection(assistantSessionId: string, toolCallId: string) {
    return this.store.toolExecutionProjection(assistantSessionId, toolCallId);
  }
  runTraceProjections(assistantSessionId: string, limit: number) {
    return this.store.runTraceProjections(assistantSessionId, limit);
  }
}
