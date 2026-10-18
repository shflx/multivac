import { SqliteNoteSuggestionsRepository, NOTE_SUGGESTIONS_MIGRATION } from './sqlite-note-suggestions-repository.js';
import { SqliteNoteAssistantRepository, NOTE_ASSISTANT_MIGRATION } from './sqlite-note-assistant-repository.js';
import { SqliteNotesRepository, NOTES_MIGRATION, NOTE_DELETION_MIGRATION } from './sqlite-notes-repository.js';
import { NOTE_SUMMARY_MIGRATION } from './sqlite-note-summaries.js';
import { SqliteSkillRepository, SKILL_MIGRATION } from './sqlite-skill-repository.js';
import { READING_CONTENT_MIGRATION } from './sqlite-book-content.js';
import { SqliteUsageRepository } from './sqlite-usage-repository.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from './sqlite-inbox-repository.js';
import { REMINDER_MIGRATION, SqliteReminderRepository } from './sqlite-reminder-repository.js';
import { SqliteManagedProcessRepository, MANAGED_PROCESS_MIGRATION, MANAGED_PROCESS_COUNTS_MIGRATION } from './sqlite-managed-process-repository.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SqliteImageRepository, IMAGE_MIGRATION } from './sqlite-image-repository.js';
import { SqliteTaskRepository, TASK_MIGRATION } from './sqlite-task-repository.js';
import { AGENT_MIGRATION, SqliteAgentRepository } from './sqlite-agent-repository.js';
import { SqliteTaskRunRepository, TASK_RUN_MIGRATION, TASK_RUN_OVERVIEW_MIGRATION } from './sqlite-task-run-repository.js';
import { SqliteTaskRuntimeRepository, TASK_RUNTIME_MIGRATION } from './sqlite-task-runtime-repository.js';
import { SqliteTaskFacts } from './sqlite-task-facts.js';
import { SqliteProjectRepository } from './sqlite-project-repository.js';
import { SqliteSessionSelectionRepository } from './sqlite-session-selection-repository.js';
import { SqliteProposalRepository } from './sqlite-proposal-repository.js';
import { SqliteInternalToolCallRepository } from './sqlite-internal-tool-call-repository.js';
import { SqliteTempDirectoryCleanupRepository } from './sqlite-temp-directory-cleanup-repository.js';
import { SqlitePreferenceRepository } from './sqlite-preference-repository.js';
import { toolResultFromJson } from './sqlite-tool-result-column.js';
import { SqliteSessionRegistryRepository } from './sqlite-session-registry-repository.js';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository.js';
import { SqliteWorkspaceSceneRepository } from './sqlite-workspace-scene-repository.js';
import { SqliteAssistantBindingRepository, SqliteAssistantPageStateRepository } from './sqlite-assistant-session-repository.js';
import { SqliteMessageFileSourceRepository } from './sqlite-message-file-source-repository.js';
import { runInTransaction } from './sqlite-transaction.js';
import { SqliteHumanRequestRepository, HUMAN_REQUEST_MIGRATION } from './sqlite-human-request-repository.js';
import { SqliteArtifactRepository, ARTIFACT_MIGRATION } from './sqlite-artifact-repository.js';
import {
  SqliteReadingRepository,
  READING_MIGRATION,
  READING_ANNOTATION_MIGRATION,
  READING_COMPANION_MIGRATION,
  READING_DISCUSSION_MIGRATION,
} from './sqlite-reading-repository.js';
import { SqliteReadingNotesRepository, READING_NOTES_MIGRATION } from './sqlite-reading-notes-repository.js';
import { SqliteReadingCollectionRepository, READING_COLLECTION_MIGRATION } from './sqlite-reading-collection-repository.js';
import type {
  AssistantCommandKind,
  AssistantCommandStatus,
  AssistantCommandTerminalOutcome,
  AssistantPublicEvent,
  ToolAuthorizationAccess,
  ToolAuthorizationApproval,
  ToolAuthorizationGrant,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
  WorkingDirectory,
} from '@multivac/contracts';
import {
  assistantExecutionError,
  AssistantToolResultSchema,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  GLOBAL_ASSISTANT_SESSION_ID,
  truncateAssistantThinkingDelta,
  truncateAssistantThinkingTrace,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { migrateLegacyManagementReceipt } from './legacy-management-receipt.js';
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
import {
  grantCovers,
  type NewToolAuthorizationGrant,
  type NewToolAuthorizationRequest,
  type ResolvedToolAuthorizationStatus,
  type ToolAuthorizationGrantQuery,
  type ToolAuthorizationMutation,
  type ToolAuthorizationRepository,
  type ToolAuthorizationUserApproval,
} from '../modules/tool-authorization/tool-authorization.js';

interface CommandRow {
  command_id: string;
  agent_execution_json: string | null;
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

interface ToolAuthorizationRow {
  request_id: string;
  assistant_id: string;
  command_id: string | null;
  tool_name: ToolAuthorizationRequest['toolName'];
  tool_call_id: string;
  requested_path: string;
  target_path: string;
  working_directory_kind: WorkingDirectory['kind'];
  working_directory_path: string;
  status: ToolAuthorizationStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  approval_scope: ToolAuthorizationApproval['scope'] | null;
  approval_source: ToolAuthorizationApproval['source'] | null;
  grant_id: string | null;
  remember_directory: string | null;
  remember_project_id: string | null;
}

interface ToolAuthorizationGrantRow {
  grant_id: string;
  scope: ToolAuthorizationGrant['scope'];
  session_id: string | null;
  project_id: string | null;
  access: ToolAuthorizationAccess;
  directory: string;
  source_request_id: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  revoked_at: string | null;
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
  result_json: string | null;
}

interface RunTraceEventRow extends EventRow {}

interface MutableRunTraceProjection extends RunTraceProjection {
  thinkingText: string;
}

/** 顶层带 toolCallId 的事件只有工具事件；授权事件的 toolCallId 在 request 内，不参与归并。 */
const TOOL_EVENT_TYPES = `'assistant.tool.started', 'assistant.tool.updated', 'assistant.tool.ended'`;

/** 工具记录只读取输入与内部工具公开的结果；旧投影缺少字段时按空处理，不读取输出正文。 */
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
    THEN json_extract(payload_json, '$.inputTruncated') END) AS input_truncated,
  MAX(CASE WHEN event_type = 'assistant.tool.ended'
    THEN json_extract(payload_json, '$.result') END) AS result_json
`;

function toolExecutionFromRow(
  row: ToolExecutionRow,
  authorization: ToolExecutionProjection['authorization'] = null,
): ToolExecutionProjection {
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
    authorization,
    result: toolResultFromJson(row.result_json),
  };
}

/** 命令对账的终态映射为轨迹终态；轨迹只区分完成、取消与其余失败。 */
function runTraceOutcome(outcome: AssistantCommandTerminalOutcome | null): RunTraceProjection['status'] {
  if (outcome === 'succeeded') return 'succeeded';
  return outcome === 'cancelled' ? 'cancelled' : 'failed';
}

// 独立标识这次迁移，后续追加迁移不会改变快照列所属的版本。
const SESSION_INITIAL_MODEL_MIGRATION = 'SELECT 1; -- session initial model snapshot';

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
  // 注册表的工作目录字段（类型与绝对路径）同样按列补充；存量记录的目录由应用启动时补齐。
  `SELECT 1;`,
  // 目录外访问的授权请求：待授权记录随等待持久化，启动时遗留的待授权记录由应用置为已失效。
  `
    CREATE TABLE IF NOT EXISTS tool_authorization_request (
      request_id TEXT PRIMARY KEY,
      assistant_id TEXT NOT NULL,
      command_id TEXT,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      requested_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      working_directory_kind TEXT NOT NULL,
      working_directory_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired', 'invalidated')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      FOREIGN KEY (assistant_id) REFERENCES assistant_session_binding(assistant_id) ON DELETE CASCADE,
      FOREIGN KEY (command_id) REFERENCES assistant_command_receipt(command_id) ON DELETE SET NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS tool_authorization_request_session_idx
      ON tool_authorization_request (assistant_id, created_at);
    CREATE INDEX IF NOT EXISTS tool_authorization_request_pending_idx
      ON tool_authorization_request (status) WHERE status = 'pending';
  `,
  // 项目与多工作区：项目至少一个目录（第一个为主目录），项目自动带一个同 id 的工作区，名称取项目名称；
  // 默认工作区作为一条不属于项目的记录迁入。已有会话与现场本就按 'default' 保存，归属不变。
  `
    CREATE TABLE IF NOT EXISTS project (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      default_constraints TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS project_directory (
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('managed', 'mounted')),
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, position),
      FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS workspace (
      workspace_id TEXT PRIMARY KEY,
      name TEXT,
      project_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      CHECK ((project_id IS NULL) <> (name IS NULL)),
      FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE
    ) STRICT;

    INSERT OR IGNORE INTO workspace (workspace_id, name, project_id, created_at)
    VALUES ('${DEFAULT_WORKSPACE_ID}', '${DEFAULT_WORKSPACE_NAME}', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `,
  // 记住的授权：用户在授权卡上选择“本会话内 / 本项目内”后，对某个目录（含子目录）的读取或修改不再确认。
  // 会话范围随会话记录、项目范围随项目删除；撤销只标记时间，记录保留以便追溯。
  // 授权请求补充批准范围与来源、命中的授权，以及创建时算出的可记住范围（由 TypeScript 按列补充）。
  `
    CREATE TABLE IF NOT EXISTS tool_authorization_grant (
      grant_id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
      session_id TEXT,
      project_id TEXT,
      access TEXT NOT NULL CHECK (access IN ('read', 'write')),
      directory TEXT NOT NULL,
      source_request_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,
      CHECK ((scope = 'session') = (session_id IS NOT NULL)),
      CHECK ((scope = 'project') = (project_id IS NOT NULL)),
      FOREIGN KEY (session_id) REFERENCES assistant_session_registry(session_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES project(project_id) ON DELETE CASCADE,
      FOREIGN KEY (source_request_id) REFERENCES tool_authorization_request(request_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS tool_authorization_grant_active_idx
      ON tool_authorization_grant (access, created_at) WHERE revoked_at IS NULL;
  `,
  // 临时目录的生命周期与偏好：清理计划只记录起算时间（归档或归入项目的时间），到期时间按当前偏好计算；
  // 目录类型只接受临时目录。已移到废纸篓的计划为归档的会话保留，恢复时据此提示。偏好按键保存 JSON 值。
  `
    CREATE TABLE IF NOT EXISTS temp_directory_cleanup (
      path TEXT PRIMARY KEY,
      directory_kind TEXT NOT NULL CHECK (directory_kind = 'session-temp'),
      reason TEXT NOT NULL CHECK (reason IN ('archived', 'orphaned')),
      session_id TEXT NOT NULL,
      since TEXT NOT NULL,
      trashed_at TEXT,
      trash_path TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS temp_directory_cleanup_pending_idx
      ON temp_directory_cleanup (since) WHERE trashed_at IS NULL;

    CREATE TABLE IF NOT EXISTS app_preference (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `,
  // 全局 Multivac 内部工具中有副作用的调用（管理与提议）的账本：命令 id 由会话与 toolCallId 派生，
  // 先写入 running 再执行、结束时写入结果；同一调用再次到达时只读这里，不重新执行。
  `
    CREATE TABLE IF NOT EXISTS internal_tool_call (
      command_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      effect TEXT NOT NULL CHECK (effect IN ('manage', 'propose')),
      arguments_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      outcome_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'running') = (outcome_json IS NULL)),
      FOREIGN KEY (session_id) REFERENCES assistant_session_registry(session_id) ON DELETE CASCADE
    ) STRICT;
  `,
  // 工作区现场的版本：内容每变化一次加一，窗口据此判断推送来的现场是否更新，保存时据此发现别处的改动。
  // 列由 TypeScript 按是否存在补充，保持重放幂等；存量现场从 0 开始。
  `SELECT 1;`,
  // 全局 Multivac 对话内的提议（确认卡）：提议类内部工具生成、用户确认或取消。同一会话的同一次工具调用只有一张；
  // notified_at 记下结果何时随服务端通知告诉了模型。提议不随服务重启失效，只有执行中的在启动时记为执行失败。
  `
    CREATE TABLE IF NOT EXISTS internal_tool_proposal (
      proposal_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      command_id TEXT,
      tool_call_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      problem TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'executed', 'cancelled', 'expired', 'failed')),
      outcome_json TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      updated_at TEXT NOT NULL,
      notified_at TEXT,
      UNIQUE (session_id, tool_call_id),
      CHECK ((status = 'executed') = (outcome_json IS NOT NULL)),
      CHECK ((status = 'pending') = (decided_at IS NULL)),
      FOREIGN KEY (session_id) REFERENCES assistant_session_registry(session_id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX IF NOT EXISTS internal_tool_proposal_session_idx
      ON internal_tool_proposal (session_id, created_at);
  `,
  `
    CREATE TABLE IF NOT EXISTS assistant_message_file_source (
      session_id TEXT NOT NULL,
      pi_session_id TEXT NOT NULL,
      pi_entry_id TEXT NOT NULL,
      references_json TEXT NOT NULL,
      PRIMARY KEY (session_id, pi_session_id, pi_entry_id)
    ) STRICT;
  `,
  TASK_MIGRATION,
  TASK_RUN_MIGRATION,
  TASK_RUNTIME_MIGRATION,
  HUMAN_REQUEST_MIGRATION,
  ARTIFACT_MIGRATION,
  READING_MIGRATION,
  READING_ANNOTATION_MIGRATION,
  READING_COMPANION_MIGRATION,
  READING_NOTES_MIGRATION,
  READING_DISCUSSION_MIGRATION,
  READING_COLLECTION_MIGRATION,
  READING_CONTENT_MIGRATION,
  INBOX_MIGRATION,
  IMAGE_MIGRATION,
  // 子会话创建时冻结的模型快照；只存无秘密配置，不随父会话或全局默认更新。
  SESSION_INITIAL_MODEL_MIGRATION,
  MANAGED_PROCESS_MIGRATION,
  `CREATE TABLE IF NOT EXISTS assistant_prompt_anchor (
    command_id TEXT PRIMARY KEY REFERENCES assistant_command_receipt(command_id) ON DELETE CASCADE,
    baseline_pi_entry_id TEXT,
    user_pi_entry_id TEXT
  ) STRICT;`,
  // 按事件类型读取（在途正文、运行终态、工具与运行轨迹）只走索引，不随会话事件总量线性扫描正文。
  `CREATE INDEX IF NOT EXISTS assistant_event_projection_type_idx
    ON assistant_event_projection (assistant_id, event_type, command_id, cursor);`,
  AGENT_MIGRATION,
  NOTES_MIGRATION,
  NOTE_ASSISTANT_MIGRATION,
  NOTE_SUGGESTIONS_MIGRATION,
  NOTE_DELETION_MIGRATION,
  REMINDER_MIGRATION,
  MANAGED_PROCESS_COUNTS_MIGRATION,
  TASK_RUN_OVERVIEW_MIGRATION,
  `ALTER TABLE assistant_page_state ADD COLUMN agent_id TEXT;
   ALTER TABLE assistant_command_receipt ADD COLUMN agent_execution_json TEXT;`,
  NOTE_SUMMARY_MIGRATION,
  SKILL_MIGRATION,
] as const;

/** 工具正文清理绑定到它所属的那次迁移，后续新增迁移不会重复或错位执行。 */
const TOOL_PAYLOAD_CLEANUP_MIGRATION_INDEX = 6;
/** 会话注册表补充父会话与来源引用列的迁移。 */
const SESSION_PARENT_MIGRATION_INDEX = 10;
/** 会话注册表补充工作目录列的迁移。 */
const SESSION_WORKING_DIRECTORY_MIGRATION_INDEX = 11;
/** 记住的授权，以及授权请求补充批准与可记住范围列的迁移。 */
const TOOL_AUTHORIZATION_GRANT_MIGRATION_INDEX = 14;
/** 工作区现场补充版本列的迁移。 */
const WORKSPACE_SCENE_REVISION_MIGRATION_INDEX = 17;

/**
 * 各次迁移按列是否存在补充的列；ALTER TABLE 不支持 IF NOT EXISTS。
 * 列定义缺省为可空 TEXT，definition 给出时按它补充（需带默认值，存量行随之取默认值）。
 */
const COLUMN_MIGRATIONS: Readonly<Record<number, { table: string; columns: readonly string[]; definition?: string }>> = {
  [MIGRATIONS.indexOf(SESSION_INITIAL_MODEL_MIGRATION)]: {
    table: 'assistant_session_registry',
    columns: ['initial_model_json'],
  },
  [SESSION_PARENT_MIGRATION_INDEX]: {
    table: 'assistant_session_registry',
    columns: ['parent_session_id', 'origin_json'],
  },
  [SESSION_WORKING_DIRECTORY_MIGRATION_INDEX]: {
    table: 'assistant_session_registry',
    columns: ['working_directory_kind', 'working_directory_path'],
  },
  [TOOL_AUTHORIZATION_GRANT_MIGRATION_INDEX]: {
    table: 'tool_authorization_request',
    columns: ['approval_scope', 'approval_source', 'grant_id', 'remember_directory', 'remember_project_id'],
  },
  [WORKSPACE_SCENE_REVISION_MIGRATION_INDEX]: {
    table: 'workspace_scene',
    columns: ['revision'],
    definition: 'INTEGER NOT NULL DEFAULT 0',
  },
};

function toolAuthorizationFromRow(row: ToolAuthorizationRow): ToolAuthorizationRequest {
  return {
    requestId: row.request_id,
    sessionId: row.assistant_id,
    commandId: row.command_id,
    toolName: row.tool_name,
    toolCallId: row.tool_call_id,
    requestedPath: row.requested_path,
    targetPath: row.target_path,
    workingDirectory: { kind: row.working_directory_kind, path: row.working_directory_path },
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    approval: approvalFromColumns(row),
    remember: row.remember_directory
      ? { directory: row.remember_directory, projectId: row.remember_project_id }
      : null,
  };
}

/** 批准范围只随已批准的请求保存；缺列（迁移前的记录）按仅这一次的用户决定处理。 */
function approvalFromColumns(row: Pick<ToolAuthorizationRow, 'status' | 'approval_scope' | 'approval_source' | 'grant_id'>): ToolAuthorizationApproval | null {
  if (row.status !== 'approved') return null;
  return {
    scope: row.approval_scope ?? 'once',
    source: row.approval_source ?? 'user',
    grantId: row.grant_id,
  };
}

function toolAuthorizationGrantFromRow(row: ToolAuthorizationGrantRow): ToolAuthorizationGrant {
  return {
    grantId: row.grant_id,
    scope: row.scope,
    sessionId: row.session_id,
    projectId: row.project_id,
    access: row.access,
    directory: row.directory,
    sourceRequestId: row.source_request_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    revokedAt: row.revoked_at,
  };
}

function commandFromRow(row: CommandRow): StoredAssistantCommandReceipt {
  return {
    commandId: row.command_id,
    assistantSessionId: row.assistant_id,
    kind: row.kind,
    payloadFingerprint: row.payload_fingerprint,
    ...(row.agent_execution_json ? { agentExecution: JSON.parse(row.agent_execution_json), executor: JSON.parse(row.agent_execution_json).executor } : {}),
    dispatchMode: row.dispatch_mode,
    status: row.phase,
    terminalOutcome: row.terminal_outcome,
    error: row.error_code && row.error_message
      ? assistantExecutionError(row.error_code, row.error_message) ?? null
      : null,
    piSessionId: row.pi_session_id,
    piEntryId: row.pi_entry_id,
    piTurnRef: row.pi_turn_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicEventData(type: AssistantPublicEvent['type'], data: AssistantPublicEvent['data']): AssistantPublicEvent['data'] {
  if (type === 'assistant.run.failed') {
    const failed = data as Extract<AssistantPublicEvent, { type: 'assistant.run.failed' }>['data'];
    const error = failed.error && assistantExecutionError(failed.error.code, failed.error.message);
    return error ? { error } : {};
  }
  if (type === 'assistant.command.rejected') {
    const rejected = data as Extract<AssistantPublicEvent, { type: 'assistant.command.rejected' }>['data'];
    return { error: assistantExecutionError(rejected.error.code, rejected.error.message) ?? { code: 'RUNTIME_OPERATION_FAILED', message: '原因未提供。' } };
  }
  if (type === 'assistant.command.reconciled') {
    const reconciled = data as Extract<AssistantPublicEvent, { type: 'assistant.command.reconciled' }>['data'];
    return { status: reconciled.status, terminalOutcome: reconciled.terminalOutcome,
      error: reconciled.error ? assistantExecutionError(reconciled.error.code, reconciled.error.message) ?? null : null };
  }
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
    const result = migrateLegacyManagementReceipt(ended.result);
    // 结果正文不落库；只保留通过契约白名单的内部工具结果（摘要与对象）。
    return {
      toolCallId: ended.toolCallId,
      toolName: ended.toolName,
      isError: ended.isError,
      ...(!ended.isError && result !== undefined && Check(AssistantToolResultSchema, result)
        ? { result }
        : {}),
    };
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
  readonly usage: SqliteUsageRepository;
  readonly images: SqliteImageRepository;
  readonly tasks: SqliteTaskRepository;
  readonly agents: SqliteAgentRepository;
  readonly managedProcesses: SqliteManagedProcessRepository;
  readonly taskRuns: SqliteTaskRunRepository;
  readonly taskRuntime: SqliteTaskRuntimeRepository;
  /** 任务、运行、人工请求、成果与调度权的事务入口。 */
  readonly taskFacts: SqliteTaskFacts;
  /** 项目、项目目录与同名工作区。 */
  readonly projects: SqliteProjectRepository;
  /** 会话选模意图、命令与已对账的绑定模型。 */
  readonly selections: SqliteSessionSelectionRepository;
  readonly humanRequests: SqliteHumanRequestRepository;
  readonly inbox: SqliteInboxRepository;
  readonly reminders: SqliteReminderRepository;
  readonly artifacts: SqliteArtifactRepository;
  readonly reading: SqliteReadingRepository;
  readonly notes: SqliteNotesRepository;
  readonly noteAssistant: SqliteNoteAssistantRepository;
  readonly noteSuggestions: SqliteNoteSuggestionsRepository;
  readonly readingNotes: SqliteReadingNotesRepository;
  readonly skills: SqliteSkillRepository;
  readonly readingCollection: SqliteReadingCollectionRepository;
  /** Multivac 会话注册表。 */
  readonly sessions: SqliteSessionRegistryRepository;
  /** 工作区；项目信息经项目仓储补全。 */
  readonly workspaces: SqliteWorkspaceRepository;
  readonly workspaceScenes: SqliteWorkspaceSceneRepository;
  readonly bindings: SqliteAssistantBindingRepository;
  readonly pageStates: SqliteAssistantPageStateRepository;
  readonly messageFileSources: SqliteMessageFileSourceRepository;
  readonly preferences: SqlitePreferenceRepository;
  readonly tempDirectoryCleanups: SqliteTempDirectoryCleanupRepository;
  readonly internalToolCalls: SqliteInternalToolCallRepository;
  readonly proposals: SqliteProposalRepository;
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath: string, options: SqliteAssistantStoreOptions = {}) {
    this.database = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrate();
      this.projects = new SqliteProjectRepository(this.database, (workspaceId) => this.workspaces.get(workspaceId));
      this.selections = new SqliteSessionSelectionRepository(this.database, () => this.now());
      this.sessions = new SqliteSessionRegistryRepository(this.database);
      this.workspaces = new SqliteWorkspaceRepository(this.database, (projectId) => this.projects.get(projectId));
      this.workspaceScenes = new SqliteWorkspaceSceneRepository(this.database, () => this.now());
      this.bindings = new SqliteAssistantBindingRepository(this.database);
      this.pageStates = new SqliteAssistantPageStateRepository(this.database, () => this.now());
      this.messageFileSources = new SqliteMessageFileSourceRepository(this.database);
      this.preferences = new SqlitePreferenceRepository(this.database, () => this.now());
      this.tempDirectoryCleanups = new SqliteTempDirectoryCleanupRepository(this.database);
      this.internalToolCalls = new SqliteInternalToolCallRepository(this.database);
      this.proposals = new SqliteProposalRepository(this.database, () => this.now());
      this.usage = new SqliteUsageRepository(this.database);
      this.inbox = new SqliteInboxRepository(this.database);
      this.reminders = new SqliteReminderRepository(this.database);
      this.images = new SqliteImageRepository(this.database);
      this.tasks = new SqliteTaskRepository(this.database);
      this.agents = new SqliteAgentRepository(this.database);
      this.managedProcesses = new SqliteManagedProcessRepository(this.database);
      this.taskRuns = new SqliteTaskRunRepository(this.database);
      this.taskRuntime = new SqliteTaskRuntimeRepository(this.database);
      this.humanRequests = new SqliteHumanRequestRepository(this.database);
      this.artifacts = new SqliteArtifactRepository(this.database);
      this.taskFacts = new SqliteTaskFacts(this.database, { tasks: this.tasks, runs: this.taskRuns, requests: this.humanRequests, artifacts: this.artifacts, runtime: this.taskRuntime, externalOperations: this.inbox });
      this.reading = new SqliteReadingRepository(this.database);
      this.notes = new SqliteNotesRepository(this.database);
      this.noteAssistant = new SqliteNoteAssistantRepository(this.database);
      this.noteSuggestions = new SqliteNoteSuggestionsRepository(this.database);
      this.readingNotes = new SqliteReadingNotesRepository(this.database);
      this.skills = new SqliteSkillRepository(this.database);
      this.readingCollection = new SqliteReadingCollectionRepository(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  /** 仅供 Fake E2E 清理业务事实；调用方须先确认所有测试执行停止。 */
  resetTasksForTest(): void {
    if (this.taskRuns.active().length || this.managedProcesses.all().some((record) => !['exited', 'failed'].includes(record.public.state))) throw new Error('尚有未停止的任务执行或托管进程，不能重置。');
    this.database.exec('DELETE FROM managed_process_command; DELETE FROM managed_process;');
    this.database.exec('BEGIN; DELETE FROM reminder_command; DELETE FROM inbox_notification; DELETE FROM reminder_timer; DELETE FROM reminder; DELETE FROM inbox_state; DELETE FROM inbox_external; DELETE FROM inbox_command; DELETE FROM task_artifact_version; DELETE FROM task_human_request; DELETE FROM task_run; DELETE FROM task_event; DELETE FROM task_command; DELETE FROM task_dependency; DELETE FROM task; DELETE FROM task_group; COMMIT;');
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
      SELECT r.command_id, r.agent_execution_json, COALESCE(r.pi_entry_id, a.user_pi_entry_id) AS pi_entry_id
      FROM assistant_command_receipt r LEFT JOIN assistant_prompt_anchor a ON a.command_id = r.command_id
      WHERE r.assistant_id = ? AND COALESCE(r.pi_entry_id, a.user_pi_entry_id) IS NOT NULL
      ORDER BY r.created_at, r.command_id
    `).all(assistantSessionId) as unknown as { command_id: string; pi_entry_id: string; agent_execution_json: string | null }[];
    return rows.map((row) => ({ commandId: row.command_id, piEntryId: row.pi_entry_id,
      ...(row.agent_execution_json ? { executor: JSON.parse(row.agent_execution_json).executor } : {}),
    }));
  }

  preparePromptAnchor(commandId: string, baselinePiEntryId: string | null): void {
    this.database.prepare('INSERT OR IGNORE INTO assistant_prompt_anchor (command_id, baseline_pi_entry_id) VALUES (?, ?)')
      .run(commandId, baselinePiEntryId);
  }

  getPromptAnchor(commandId: string): { baselinePiEntryId: string | null; userPiEntryId: string | null } | undefined {
    const row = this.database.prepare('SELECT baseline_pi_entry_id, user_pi_entry_id FROM assistant_prompt_anchor WHERE command_id=?')
      .get(commandId) as { baseline_pi_entry_id: string | null; user_pi_entry_id: string | null } | undefined;
    return row && { baselinePiEntryId: row.baseline_pi_entry_id, userPiEntryId: row.user_pi_entry_id };
  }

  anchorPrompt(commandId: string, userPiEntryId: string): void {
    this.database.prepare('UPDATE assistant_prompt_anchor SET user_pi_entry_id=? WHERE command_id=? AND user_pi_entry_id IS NULL')
      .run(userPiEntryId, commandId);
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
          pi_turn_ref, created_at, updated_at, agent_execution_json
        ) VALUES (?, ?, ?, ?, NULL, 'accepted', NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?)
      `).run(
        input.commandId,
        input.assistantSessionId,
        input.kind,
        input.payloadFingerprint,
        input.piSessionId,
        now,
        now,
        input.agentExecution ? JSON.stringify(input.agentExecution) : null,
      );
      const event = this.appendEventRow({
        sourceKey: `command:${input.commandId}:accepted`,
        assistantSessionId: input.assistantSessionId,
        commandId: input.commandId,
        type: 'assistant.command.accepted',
        data: { kind: input.kind, ...(input.agentExecution ? { executor: input.agentExecution.executor } : {}) },
        occurredAt: now,
      });
      return { receipt: this.requireCommand(input.commandId), event };
    });
  }

  reject(commandId: string, error: { code: string; message: string }): AssistantCommandEventMutation {
    return this.transaction(() => {
      error = assistantExecutionError(error.code, error.message) ?? { code: 'RUNTIME_OPERATION_FAILED', message: '原因未提供。' };
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
      error = error ? assistantExecutionError(error.code, error.message) : undefined;
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

  getToolAuthorization(requestId: string): ToolAuthorizationRequest | undefined {
    const row = this.database.prepare('SELECT * FROM tool_authorization_request WHERE request_id = ?')
      .get(requestId) as unknown as ToolAuthorizationRow | undefined;
    return row ? toolAuthorizationFromRow(row) : undefined;
  }

  allToolAuthorizations(): ToolAuthorizationRequest[] {
    return (this.database.prepare('SELECT * FROM tool_authorization_request ORDER BY created_at,request_id').all() as unknown as ToolAuthorizationRow[]).map(toolAuthorizationFromRow);
  }

  listToolAuthorizations(sessionId: string): ToolAuthorizationRequest[] {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_request WHERE assistant_id = ? ORDER BY created_at, rowid
    `).all(sessionId) as unknown as ToolAuthorizationRow[];
    return rows.map(toolAuthorizationFromRow);
  }

  /** 最近的请求，最近的在前；给出会话时只取这个会话的（按会话与创建时间的索引读取）。 */
  listRecentToolAuthorizations(limit: number, sessionId?: string): ToolAuthorizationRequest[] {
    const rows = (sessionId === undefined
      ? this.database.prepare(`
          SELECT * FROM tool_authorization_request ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(limit)
      : this.database.prepare(`
          SELECT * FROM tool_authorization_request WHERE assistant_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?
        `).all(sessionId, limit)) as unknown as ToolAuthorizationRow[];
    return rows.map(toolAuthorizationFromRow);
  }

  createToolAuthorization(request: NewToolAuthorizationRequest): ToolAuthorizationMutation {
    return this.transaction(() => {
      this.insertToolAuthorizationRow(request);
      const created = this.requireToolAuthorization(request.requestId);
      const event = this.appendEventRow({
        sourceKey: `authorization:${request.requestId}:requested`,
        assistantSessionId: created.sessionId,
        commandId: created.commandId,
        type: 'assistant.authorization.requested',
        data: { request: created },
        occurredAt: created.createdAt,
      });
      return { request: created, event };
    });
  }

  /**
   * 按已记住的授权放行：请求直接以已批准（来源为记住的授权）写入，决定时间即创建时间；
   * 同一事务里更新授权的使用记录，只追加 resolved 事件（没有待授权阶段，不会出现授权卡）。
   */
  createRememberedToolAuthorization(request: NewToolAuthorizationRequest, grantId: string): ToolAuthorizationMutation {
    return this.transaction(() => {
      const grant = this.getToolAuthorizationGrant(grantId);
      if (!grant || grant.revokedAt !== null) throw new Error(`记住的授权不存在或已撤销：${grantId}`);
      this.insertToolAuthorizationRow(request, {
        decidedAt: request.createdAt,
        approval: { scope: grant.scope, source: 'grant', grantId },
      });
      this.database.prepare(`
        UPDATE tool_authorization_grant SET last_used_at = ?, use_count = use_count + 1 WHERE grant_id = ?
      `).run(request.createdAt, grantId);
      const created = this.requireToolAuthorization(request.requestId);
      const event = this.appendEventRow({
        sourceKey: `authorization:${request.requestId}:resolved`,
        assistantSessionId: created.sessionId,
        commandId: created.commandId,
        type: 'assistant.authorization.resolved',
        data: { request: created },
        occurredAt: created.createdAt,
      });
      return { request: created, event };
    });
  }

  resolveToolAuthorization(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationMutation {
    return this.transaction(() => this.resolveToolAuthorizationRow(requestId, status, decidedAt, approval));
  }

  /** 匹配的第一条仍有效的授权：会话范围优先，同范围内先记住的优先。路径包含关系按路径段判断。 */
  findToolAuthorizationGrant(query: ToolAuthorizationGrantQuery): ToolAuthorizationGrant | undefined {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_grant
      WHERE revoked_at IS NULL AND access = ?
        AND ((scope = 'session' AND session_id = ?) OR (scope = 'project' AND project_id = ?))
      ORDER BY scope = 'project', created_at, rowid
    `).all(query.access, query.sessionId, query.projectId) as unknown as ToolAuthorizationGrantRow[];
    return rows.map(toolAuthorizationGrantFromRow).find((grant) => grantCovers(grant, query));
  }

  listToolAuthorizationGrants(): ToolAuthorizationGrant[] {
    const rows = this.database.prepare(`
      SELECT * FROM tool_authorization_grant WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC
    `).all() as unknown as ToolAuthorizationGrantRow[];
    return rows.map(toolAuthorizationGrantFromRow);
  }

  getToolAuthorizationGrant(grantId: string): ToolAuthorizationGrant | undefined {
    const row = this.database.prepare('SELECT * FROM tool_authorization_grant WHERE grant_id = ?')
      .get(grantId) as unknown as ToolAuthorizationGrantRow | undefined;
    return row ? toolAuthorizationGrantFromRow(row) : undefined;
  }

  revokeToolAuthorizationGrant(grantId: string, revokedAt: string): ToolAuthorizationGrant | undefined {
    this.database.prepare(`
      UPDATE tool_authorization_grant SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL
    `).run(revokedAt, grantId);
    return this.getToolAuthorizationGrant(grantId);
  }

  deleteAllToolAuthorizationGrantsForTest(): void {
    this.database.exec('DELETE FROM tool_authorization_grant');
  }

  invalidatePendingToolAuthorizations(decidedAt: string): ToolAuthorizationMutation[] {
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT request_id FROM tool_authorization_request WHERE status = 'pending' ORDER BY created_at, rowid
      `).all() as unknown as Array<{ request_id: string }>;
      return rows.map((row) => this.resolveToolAuthorizationRow(row.request_id, 'invalidated', decidedAt));
    });
  }

  latestCursor(): string {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(cursor), 0) AS cursor FROM assistant_event_projection
    `).get() as unknown as { cursor: number };
    return String(row.cursor);
  }

  /**
   * 按命令排除已终结正文；与 cursor/Pi 历史的同步读取间不让出事件循环。
   * 先按命令取最后一次运行终态，再保留其后的正文：逐条正文回查终态会随单轮正文数平方增长。
   */
  streamingEvents(assistantSessionId: string): AssistantPublicEvent[] {
    const rows = this.database.prepare(`
      WITH terminal AS (
        SELECT command_id, MAX(cursor) AS cursor
        FROM assistant_event_projection
        WHERE assistant_id = ? AND event_type IN
          ('assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled')
        GROUP BY command_id
      )
      SELECT d.cursor, d.assistant_id, d.command_id, d.event_type, d.payload_json, d.occurred_at
      FROM assistant_event_projection d
      LEFT JOIN terminal t ON t.command_id IS d.command_id
      WHERE d.assistant_id = ? AND d.event_type = 'assistant.message.delta'
        AND (t.cursor IS NULL OR t.cursor < d.cursor)
        AND NOT EXISTS (SELECT 1 FROM assistant_command_receipt r
          WHERE r.command_id = d.command_id AND r.phase = 'terminal'
            AND r.error_code = 'COMMAND_INTERRUPTED')
      ORDER BY d.cursor
    `).all(assistantSessionId, assistantSessionId) as unknown as EventRow[];
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
            SET phase = 'terminal', terminal_outcome = ?, error_code = ?,
                error_message = ?, updated_at = ?
            WHERE command_id = ? AND phase != 'terminal'
          `).run(receiptUpdate.terminalOutcome,
            receiptUpdate.terminalOutcome === 'failed' ? (event.type === 'assistant.run.failed' ? event.data.error?.code : undefined) ?? null : null,
            receiptUpdate.terminalOutcome === 'failed' ? (event.type === 'assistant.run.failed' ? event.data.error?.message : undefined) ?? null : null,
            input.occurredAt, receiptUpdate.commandId);
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
      WHERE assistant_id = ? AND event_type IN (${TOOL_EVENT_TYPES}) AND tool_call_id IS NOT NULL
      GROUP BY tool_call_id
      ${having}
      ORDER BY cursor DESC
      LIMIT ?
    `).all(...parameters) as unknown as ToolExecutionRow[];
    return this.withToolAuthorizations(assistantSessionId, rows).reverse();
  }

  toolExecutionProjection(
    assistantSessionId: string,
    toolCallId: string,
  ): ToolExecutionProjection | undefined {
    const rows = this.database.prepare(`
      SELECT ${TOOL_EXECUTION_SELECT}
      FROM assistant_event_projection
      WHERE assistant_id = ? AND event_type IN (${TOOL_EVENT_TYPES}) AND tool_call_id = ?
      GROUP BY tool_call_id
    `).all(assistantSessionId, toolCallId) as unknown as ToolExecutionRow[];
    return this.withToolAuthorizations(assistantSessionId, rows)[0];
  }

  /**
   * 给工具记录补上该调用最近一次授权请求的状态。授权事件把 toolCallId 放在 request 内，
   * 不参与上面按 toolCallId 的归并；状态以授权请求表为准，与查询接口一致。
   */
  private withToolAuthorizations(
    assistantSessionId: string,
    rows: readonly ToolExecutionRow[],
  ): ToolExecutionProjection[] {
    if (rows.length === 0) return [];
    const authorizations = this.database.prepare(`
      SELECT request_id, tool_call_id, status, decided_at, approval_scope, approval_source, grant_id
      FROM tool_authorization_request
      WHERE assistant_id = ? AND tool_call_id IN (${rows.map(() => '?').join(', ')})
      ORDER BY created_at, rowid
    `).all(assistantSessionId, ...rows.map((row) => row.tool_call_id)) as unknown as Array<
      Pick<ToolAuthorizationRow, 'request_id' | 'tool_call_id' | 'status' | 'decided_at' |
        'approval_scope' | 'approval_source' | 'grant_id'>
    >;
    // 按创建顺序覆盖，留下每个调用最近的一条。
    const latest = new Map(authorizations.map((row) => [row.tool_call_id, {
      requestId: row.request_id,
      status: row.status,
      decidedAt: row.decided_at,
      approval: approvalFromColumns(row),
    }]));
    return rows.map((row) => toolExecutionFromRow(row, latest.get(row.tool_call_id) ?? null));
  }

  runTraceProjections(assistantSessionId: string, limit: number, commandIds: readonly string[] = []): RunTraceProjection[] {
    const ids = [...new Set(commandIds)].slice(0, 100);
    const extraCommands = ids.length === 0 ? '' : `UNION SELECT command_id FROM assistant_command_receipt
      WHERE assistant_id = ? AND dispatch_mode = 'prompt' AND command_id IN (${ids.map(() => '?').join(', ')})`;
    const parameters: SQLInputValue[] = [assistantSessionId, limit];
    if (ids.length > 0) parameters.push(assistantSessionId, ...ids);
    parameters.push(assistantSessionId);
    const rows = this.database.prepare(`
      WITH recent_commands AS (
        SELECT command_id, MAX(cursor) AS latest_cursor
        FROM assistant_event_projection
        WHERE assistant_id = ? AND command_id IS NOT NULL AND (
          event_type IN ('assistant.run.processing', 'assistant.thinking.delta',
            'assistant.tool.started', 'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled')
          OR (event_type = 'assistant.command.handed_to_pi' AND json_extract(payload_json, '$.dispatchMode') = 'prompt')
        )
        GROUP BY command_id
        ORDER BY latest_cursor DESC
        LIMIT ?
      ), selected_commands AS (SELECT command_id FROM recent_commands ${extraCommands})
      SELECT e.cursor, e.assistant_id, e.command_id, e.event_type, e.payload_json, e.occurred_at
      FROM assistant_event_projection e
      JOIN selected_commands r ON r.command_id = e.command_id
      WHERE e.assistant_id = ? AND e.event_type IN (
        'assistant.run.processing', 'assistant.thinking.delta',
        'assistant.tool.started',
        'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled',
        'assistant.command.handed_to_pi', 'assistant.command.reconciled', 'assistant.message.changed'
      )
      ORDER BY e.cursor
    `).all(...parameters) as unknown as RunTraceEventRow[];
    const traces = new Map<string, MutableRunTraceProjection>();

    for (const row of rows) {
      if (!row.command_id) continue;
      const event = eventFromRow(row);
      if (event.type === 'assistant.command.reconciled') {
        // 命令已终结而运行没有终态事件（如等待授权时服务重启、按中断对账）：轨迹随命令结束，
        // 不再显示为运行中。对账时间不是运行的结束时间，结束时间留空（摘要显示“已结束”）。
        // 正常结束时运行终态早于对账，这里不改变它。
        const trace = traces.get(row.command_id);
        if (trace?.status === 'running' && event.data.status === 'terminal') {
          trace.status = runTraceOutcome(event.data.terminalOutcome);
          delete trace.error;
          if (trace.status === 'failed' && event.data.error) trace.error = event.data.error;
          trace.cursor = event.cursor;
        }
        continue;
      }
      if (event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode !== 'prompt') continue;
      if (event.type === 'assistant.message.changed') {
        // 只记录用户消息进入运行中轨迹的位置（开始与结束各一条事件，取先到的一条）。
        const trace = traces.get(row.command_id);
        if (event.data.role !== 'user' || trace?.status !== 'running') continue;
        trace.cursor = String(row.cursor);
        if (!trace.entries.some((entry) => entry.kind === 'user' && entry.messageId === event.data.messageId)) {
          trace.entries.push({ kind: 'user', cursor: String(row.cursor), messageId: event.data.messageId });
        }
        continue;
      }
      const current: MutableRunTraceProjection = traces.get(row.command_id) ?? {
        commandId: row.command_id,
        ...(this.getCommand(row.command_id)?.executor ? { executor: this.getCommand(row.command_id)!.executor } : {}),
        cursor: String(row.cursor),
        status: 'running' as const,
        entries: [],
        thinkingText: '',
        thinkingTruncated: false,
        startedAt: row.occurred_at,
        endedAt: null,
      };
      // 已保存终态不因迟到的过程事件退回运行态，亦不改写它的结束时间和原因。
      if (current.status !== 'running') continue;
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
        delete current.error;
        current.endedAt = row.occurred_at;
      } else if (event.type === 'assistant.run.failed') {
        current.status = 'failed';
        if (event.data.error) current.error = event.data.error;
        else delete current.error;
        current.endedAt = row.occurred_at;
      } else if (event.type === 'assistant.run.cancelled') {
        current.status = 'cancelled';
        delete current.error;
        current.endedAt = row.occurred_at;
      }
      traces.set(row.command_id, current);
    }

    // 各助手消息首个正文增量的位置：只取每条消息一行，正文增量本身不参与轨迹。
    const markers = traces.size === 0 ? [] : this.database.prepare(`
      SELECT command_id, MIN(cursor) AS cursor, json_extract(payload_json, '$.messageId') AS message_id
      FROM assistant_event_projection
      WHERE assistant_id = ? AND event_type = 'assistant.message.delta' AND command_id IN (${[...traces.keys()].map(() => '?').join(', ')})
      GROUP BY command_id, message_id
    `).all(assistantSessionId, ...traces.keys()) as unknown as Array<{ command_id: string; cursor: number; message_id: unknown }>;
    for (const marker of markers) {
      const trace = traces.get(marker.command_id);
      if (!trace || typeof marker.message_id !== 'string' || !marker.message_id) continue;
      trace.entries.push({ kind: 'message', cursor: String(marker.cursor), messageId: marker.message_id });
      trace.entries.sort((left, right) => Number(left.cursor) - Number(right.cursor));
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

  private insertToolAuthorizationRow(
    request: NewToolAuthorizationRequest,
    approved?: { decidedAt: string; approval: ToolAuthorizationApproval },
  ): void {
    this.database.prepare(`
      INSERT INTO tool_authorization_request (
        request_id, assistant_id, command_id, tool_name, tool_call_id, requested_path, target_path,
        working_directory_kind, working_directory_path, status, created_at, expires_at, decided_at,
        approval_scope, approval_source, grant_id, remember_directory, remember_project_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.requestId, request.sessionId, request.commandId, request.toolName, request.toolCallId,
      request.requestedPath, request.targetPath, request.workingDirectory.kind, request.workingDirectory.path,
      approved ? 'approved' : 'pending', request.createdAt, request.expiresAt, approved?.decidedAt ?? null,
      approved?.approval.scope ?? null, approved?.approval.source ?? null, approved?.approval.grantId ?? null,
      request.remember?.directory ?? null, request.remember?.projectId ?? null,
    );
  }

  /**
   * 只有待授权的请求会转为终态；状态与事件在调用方的事务内一起提交。
   * 批准时写入范围；本会话内 / 本项目内同时记住授权，已有同一范围、类别与目录的有效授权时沿用那一条。
   */
  private resolveToolAuthorizationRow(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ): ToolAuthorizationMutation {
    const current = this.requireToolAuthorization(requestId);
    if (current.status !== 'pending') return { request: current, event: null };
    if ((status === 'approved') !== (approval !== undefined)) {
      throw new Error('只有批准需要、也必须给出批准范围。');
    }
    const grantId = approval && approval.scope !== 'once' ? this.rememberGrant(approval.grant) : null;
    this.database.prepare(`
      UPDATE tool_authorization_request
      SET status = ?, decided_at = ?, approval_scope = ?, approval_source = ?, grant_id = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(status, decidedAt, approval?.scope ?? null, approval ? 'user' : null, grantId, requestId);
    const resolved = this.requireToolAuthorization(requestId);
    const event = this.appendEventRow({
      sourceKey: `authorization:${requestId}:resolved`,
      assistantSessionId: resolved.sessionId,
      commandId: resolved.commandId,
      type: 'assistant.authorization.resolved',
      data: { request: resolved },
      occurredAt: decidedAt,
    });
    return { request: resolved, event };
  }

  /** 写入记住的授权；同一范围、类别与目录已有仍有效的授权时不重复记住，返回那一条的 id。 */
  private rememberGrant(grant: NewToolAuthorizationGrant): string {
    const existing = this.database.prepare(`
      SELECT grant_id FROM tool_authorization_grant
      WHERE revoked_at IS NULL AND scope = ? AND session_id IS ? AND project_id IS ? AND access = ? AND directory = ?
    `).get(grant.scope, grant.sessionId, grant.projectId, grant.access, grant.directory) as { grant_id: string } | undefined;
    if (existing) return existing.grant_id;
    this.database.prepare(`
      INSERT INTO tool_authorization_grant (
        grant_id, scope, session_id, project_id, access, directory, source_request_id, created_at,
        last_used_at, use_count, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
    `).run(
      grant.grantId, grant.scope, grant.sessionId, grant.projectId, grant.access, grant.directory,
      grant.sourceRequestId, grant.createdAt,
    );
    return grant.grantId;
  }

  private requireToolAuthorization(requestId: string): ToolAuthorizationRequest {
    const request = this.getToolAuthorization(requestId);
    if (!request) throw new Error(`授权请求不存在：${requestId}`);
    return request;
  }

  private requireCommand(commandId: string): StoredAssistantCommandReceipt {
    const receipt = this.getCommand(commandId);
    if (!receipt) throw new Error(`Multivac 命令不存在：${commandId}`);
    return receipt;
  }

  private transaction<T>(operation: () => T): T {
    return runInTransaction(this.database, operation);
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
        const columnMigration = COLUMN_MIGRATIONS[index];
        if (columnMigration) {
          const columns = new Set((this.database.prepare(
            'SELECT name FROM pragma_table_info(?)',
          ).all(columnMigration.table) as Array<{ name: string }>).map((column) => column.name));
          for (const column of columnMigration.columns) {
            if (!columns.has(column)) {
              this.database.exec(
                `ALTER TABLE ${columnMigration.table} ADD COLUMN ${column} ${columnMigration.definition ?? 'TEXT'};`,
              );
            }
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

export class SqliteAssistantCommandRepository implements AssistantCommandRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(commandId: string) { return this.store.getCommand(commandId); }
  listNonTerminal(assistantSessionId: string) { return this.store.listNonTerminal(assistantSessionId); }
  listCommandAnchors(assistantSessionId: string) { return this.store.listCommandAnchors(assistantSessionId); }
  preparePromptAnchor(commandId: string, baselinePiEntryId: string | null) { this.store.preparePromptAnchor(commandId, baselinePiEntryId); }
  getPromptAnchor(commandId: string) { return this.store.getPromptAnchor(commandId); }
  anchorPrompt(commandId: string, userPiEntryId: string) { this.store.anchorPrompt(commandId, userPiEntryId); }
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
  runTraceProjections(assistantSessionId: string, limit: number, commandIds?: readonly string[]) {
    return this.store.runTraceProjections(assistantSessionId, limit, commandIds);
  }
}

export class SqliteToolAuthorizationRepository implements ToolAuthorizationRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(requestId: string) { return this.store.getToolAuthorization(requestId); }
  listBySession(sessionId: string) { return this.store.listToolAuthorizations(sessionId); }
  all() { return this.store.allToolAuthorizations(); }
  listRecent(limit: number, sessionId?: string) { return this.store.listRecentToolAuthorizations(limit, sessionId); }
  create(request: NewToolAuthorizationRequest) { return this.store.createToolAuthorization(request); }
  createRemembered(request: NewToolAuthorizationRequest, grantId: string) {
    return this.store.createRememberedToolAuthorization(request, grantId);
  }
  resolve(
    requestId: string,
    status: ResolvedToolAuthorizationStatus,
    decidedAt: string,
    approval?: ToolAuthorizationUserApproval,
  ) {
    return this.store.resolveToolAuthorization(requestId, status, decidedAt, approval);
  }
  invalidatePending(decidedAt: string) { return this.store.invalidatePendingToolAuthorizations(decidedAt); }
  findGrant(query: ToolAuthorizationGrantQuery) { return this.store.findToolAuthorizationGrant(query); }
  listGrants() { return this.store.listToolAuthorizationGrants(); }
  getGrant(grantId: string) { return this.store.getToolAuthorizationGrant(grantId); }
  revokeGrant(grantId: string, revokedAt: string) { return this.store.revokeToolAuthorizationGrant(grantId, revokedAt); }
  deleteAllGrantsForTest() { this.store.deleteAllToolAuthorizationGrantsForTest(); }
}
