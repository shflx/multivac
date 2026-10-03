import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SqliteTaskRepository, TASK_MIGRATION } from './sqlite-task-repository.js';
import { SqliteTaskRunRepository, TASK_RUN_MIGRATION } from './sqlite-task-run-repository.js';
import { SqliteTaskRuntimeRepository, TASK_RUNTIME_MIGRATION } from './sqlite-task-runtime-repository.js';
import { SqliteHumanRequestRepository, HUMAN_REQUEST_MIGRATION } from './sqlite-human-request-repository.js';
import { SqliteArtifactRepository, ARTIFACT_MIGRATION } from './sqlite-artifact-repository.js';
import { SqliteReadingRepository, READING_MIGRATION, READING_ANNOTATION_MIGRATION, READING_COMPANION_MIGRATION } from './sqlite-reading-repository.js';
import type { SessionSelectionRepository, StoredSessionSelection, StoredSelectionCommand } from '../modules/sessions/session-model-selection.js';
import type {
  NewSessionRecord,
  SessionOrigin,
  SessionRecord,
  SessionRegistryRepository,
  SessionWorkspaceMove,
  StoredWorkspaceScene,
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
  SessionFileReference,
  AssistantToolResult,
  CoordinatorSessionBinding,
  Project,
  ProjectDirectory,
  ProposalStatus,
  ToolAuthorizationAccess,
  ToolAuthorizationApproval,
  ToolAuthorizationGrant,
  ToolAuthorizationRequest,
  ToolAuthorizationStatus,
  WorkingDirectory,
  Workspace,
  WorkspaceSceneState,
  WorkspaceSessionKind,
} from '@multivac/contracts';
import {
  AssistantQuoteSchema,
  FileQuoteSourceSchema,
  SessionFileReferenceSchema,
  AssistantToolResultSchema,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_NAME,
  GLOBAL_ASSISTANT_SESSION_ID,
  truncateAssistantThinkingDelta,
  truncateAssistantThinkingTrace,
  truncateAssistantToolInput,
  WorkingDirectorySchema,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { migrateLegacyManagementReceipt } from './legacy-management-receipt.js';
import { Type } from 'typebox';
import type { MessageFileSourceRepository } from '../application/message-file-sources.js';
import type {
  NewTempDirectoryCleanupPlan,
  TempCleanupReason,
  TempDirectoryCleanupPlan,
  TempDirectoryCleanupRepository,
} from '../modules/sessions/temp-directory-cleanup.js';
import type { PreferenceRepository } from '../application/preferences-service.js';
import type {
  InternalToolCallRecord,
  InternalToolCallRepository,
  InternalToolCallStatus,
  InternalToolOutcome,
} from '../modules/internal-tools/internal-tool.js';
import type {
  NewProposal,
  ProposalRecord,
  ProposalRepository,
  ProposalTransition,
} from '../modules/proposals/proposal.js';
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
import type {
  NewProjectRecord,
  ProjectRepository,
  ProjectUpdateRecord,
  WorkspaceRepository,
} from '../modules/projects/project.js';
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
  host_book_id?: string | null;
  host_book_title?: string | null;
  session_id: string;
  title: string;
  kind: WorkspaceSessionKind;
  workspace_id: string;
  created_at: string;
  archived_at: string | null;
  parent_session_id: string | null;
  origin_json: string | null;
  working_directory_kind: string | null;
  working_directory_path: string | null;
  pi_session_path: string | null;
  last_activity_at?: string;
}

interface ProjectRow {
  project_id: string;
  name: string;
  default_constraints: string;
  created_at: string;
  updated_at: string;
}

interface ProjectDirectoryRow {
  project_id: string;
  kind: ProjectDirectory['kind'];
  path: string;
}

interface WorkspaceRow {
  workspace_id: string;
  name: string;
  project_id: string | null;
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

/** 内部工具公开的结果：读出时再按契约白名单校验一次，不合格的按没有结果处理。 */
function toolResultFromJson(value: string | null): AssistantToolResult | null {
  if (value === null) return null;
  try {
    const parsed = migrateLegacyManagementReceipt(JSON.parse(value));
    return Check(AssistantToolResultSchema, parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface InternalToolCallRow {
  command_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  effect: InternalToolCallRecord['effect'];
  arguments_fingerprint: string;
  status: InternalToolCallStatus;
  outcome_json: string | null;
  created_at: string;
  updated_at: string;
}

/** 账本中保存的结果按结构读出；无法识别时按结果未知处理（不会据此重新执行）。 */
function internalToolOutcomeFromJson(value: string | null): InternalToolOutcome | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<InternalToolOutcome> & Record<string, unknown>;
    const result = migrateLegacyManagementReceipt(parsed.result);
    if (parsed.ok === true && typeof parsed.content === 'string' && Check(AssistantToolResultSchema, result)) {
      return { ok: true, content: parsed.content, result };
    }
    if (parsed.ok === false && typeof parsed.reason === 'string') return { ok: false, reason: parsed.reason };
  } catch {
    // 落到下方：结果未知。
  }
  return null;
}

interface ProposalRow {
  proposal_id: string;
  session_id: string;
  command_id: string | null;
  tool_call_id: string;
  kind: string;
  title: string;
  payload_json: string;
  preview_json: string;
  problem: string | null;
  status: ProposalStatus;
  outcome_json: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
  notified_at: string | null;
}

function jsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function proposalFromRow(row: ProposalRow): ProposalRecord {
  return {
    proposalId: row.proposal_id,
    sessionId: row.session_id,
    commandId: row.command_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    title: row.title,
    payload: jsonOrNull(row.payload_json),
    preview: jsonOrNull(row.preview_json),
    problem: row.problem,
    status: row.status,
    // 结果与工具的公开结果同一白名单，读出时再校验一次。
    outcome: toolResultFromJson(row.outcome_json),
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    notifiedAt: row.notified_at,
  };
}

function internalToolCallFromRow(row: InternalToolCallRow): InternalToolCallRecord {
  return {
    commandId: row.command_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    effect: row.effect,
    argumentsFingerprint: row.arguments_fingerprint,
    status: row.status,
    outcome: internalToolOutcomeFromJson(row.outcome_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

const SESSION_SELECT = `
  SELECT r.session_id, r.title, r.kind, r.workspace_id, r.created_at, r.archived_at,
         r.parent_session_id, r.origin_json, r.working_directory_kind, r.working_directory_path,
         b.pi_session_path AS pi_session_path,
         d.book_id AS host_book_id, json_extract(book.record_json, '$.title') AS host_book_title,
         COALESCE((SELECT MAX(e.occurred_at) FROM assistant_event_projection e
           WHERE e.assistant_id = r.session_id AND e.event_type IN
             ('assistant.command.handed_to_pi', 'assistant.message.delta', 'assistant.turn.started', 'assistant.turn.ended', 'assistant.tool.ended')), r.created_at) AS last_activity_at
  FROM assistant_session_registry r
  LEFT JOIN assistant_session_binding b ON b.assistant_id = r.session_id
  LEFT JOIN reading_discussion d ON d.session_id = r.session_id
  LEFT JOIN reading_book book ON book.book_id = d.book_id
`;

/** 项目工作区的名称取项目名称，项目改名只改一处。 */
const WORKSPACE_SELECT = `
  SELECT w.workspace_id, COALESCE(p.name, w.name) AS name, w.project_id
  FROM workspace w
  LEFT JOIN project p ON p.project_id = w.project_id
`;

/**
 * 来源引用损坏时视为没有来源，不阻断会话读取。选中内容的三个字段要么齐全，要么都没有
 * （Multivac 在对话中新建的子会话只带父会话的背景摘录）。
 */
function originFromColumn(value: string | null): SessionOrigin | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.parentTitle !== 'string' || typeof parsed.parentExcerpt !== 'string') return null;
    const background = { parentTitle: parsed.parentTitle, parentExcerpt: parsed.parentExcerpt };
    if (Check(FileQuoteSourceSchema, parsed.sourceFile) && typeof parsed.text === 'string' && parsed.text) return { ...background, text: parsed.text, sourceFile: parsed.sourceFile };
    if (parsed.text === undefined && parsed.sourcePiEntryId === undefined && parsed.sourceRole === undefined) {
      return background;
    }
    if (typeof parsed.text !== 'string' || !parsed.text ||
        typeof parsed.sourcePiEntryId !== 'string' ||
        (parsed.sourceRole !== 'user' && parsed.sourceRole !== 'assistant')) return null;
    return { ...background, sourcePiEntryId: parsed.sourcePiEntryId, sourceRole: parsed.sourceRole, text: parsed.text };
  } catch {
    return null;
  }
}

/** 工作目录列缺失（尚未迁移）或类型无法识别时视为没有工作目录，由启动迁移补齐。 */
function workingDirectoryFromColumns(kind: string | null, path: string | null): WorkingDirectory | null {
  const value = { kind, path };
  return Check(WorkingDirectorySchema, value) ? value : null;
}

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

function sessionFromRow(row: SessionRow): SessionRecord {
  const origin = originFromColumn(row.origin_json);
  return {
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    ...(row.host_book_id ? { host: { kind: 'reading' as const, bookId: row.host_book_id, title: row.host_book_title ?? '书籍已失效' } } : {}),
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at ?? row.created_at,
    archivedAt: row.archived_at,
    parentSessionId: row.parent_session_id,
    originText: origin?.text ?? null,
    workingDirectory: workingDirectoryFromColumns(row.working_directory_kind, row.working_directory_path),
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
    left.sourceTitle === right.sourceTitle &&
    left.sourceFile?.root === right.sourceFile?.root && left.sourceFile?.path === right.sourceFile?.path &&
    left.sourceFile?.line === right.sourceFile?.line && left.sourceFile?.endLine === right.sourceFile?.endLine && left.sourceFile?.section === right.sourceFile?.section;
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
  readonly tasks: SqliteTaskRepository;
  readonly taskRuns: SqliteTaskRunRepository;
  readonly taskRuntime: SqliteTaskRuntimeRepository;
  readonly humanRequests: SqliteHumanRequestRepository;
  readonly artifacts: SqliteArtifactRepository;
  readonly reading: SqliteReadingRepository;
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath: string, options: SqliteAssistantStoreOptions = {}) {
    this.database = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrate();
      this.tasks = new SqliteTaskRepository(this.database);
      this.taskRuns = new SqliteTaskRunRepository(this.database);
      this.taskRuntime = new SqliteTaskRuntimeRepository(this.database);
      this.humanRequests = new SqliteHumanRequestRepository(this.database);
      this.artifacts = new SqliteArtifactRepository(this.database);
      this.reading = new SqliteReadingRepository(this.database);
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
    if (this.taskRuns.active().length) throw new Error('尚有未停止的任务执行，不能重置。');
    this.database.exec('BEGIN; DELETE FROM task_artifact_version; DELETE FROM task_human_request; DELETE FROM task_run; DELETE FROM task_event; DELETE FROM task_command; DELETE FROM task_dependency; DELETE FROM task; DELETE FROM task_group; COMMIT;');
  }

  getMessageFiles(sessionId: string, piSessionId: string, entryId: string): SessionFileReference[] | null {
    const row = this.database.prepare('SELECT references_json FROM assistant_message_file_source WHERE session_id = ? AND pi_session_id = ? AND pi_entry_id = ?').get(sessionId, piSessionId, entryId) as { references_json: string } | undefined;
    if (!row) return null;
    try { const value: unknown = JSON.parse(row.references_json); return Check(Type.Array(SessionFileReferenceSchema, { maxItems: 20 }), value) ? value : []; }
    catch { return []; }
  }

  putMessageFilesIfAbsent(sessionId: string, piSessionId: string, entryId: string, references: SessionFileReference[]): void {
    this.database.prepare('INSERT OR IGNORE INTO assistant_message_file_source (session_id, pi_session_id, pi_entry_id, references_json) VALUES (?, ?, ?, ?)').run(sessionId, piSessionId, entryId, JSON.stringify(references));
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.database.prepare(`${SESSION_SELECT} WHERE r.session_id = ?`)
      .get(sessionId) as unknown as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  /** workspaceId 为 null 时跨全部工作区列出。 */
  listSessions(workspaceId: string | null, kind: WorkspaceSessionKind, includeArchived = false): SessionRecord[] {
    const rows = this.database.prepare(`${SESSION_SELECT}
      WHERE (? IS NULL OR r.workspace_id = ?) AND r.kind = ? AND (? = 1 OR r.archived_at IS NULL)
        AND d.session_id IS NULL
      ORDER BY r.created_at, r.session_id
    `).all(workspaceId, workspaceId, kind, includeArchived ? 1 : 0) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  insertSessionIfAbsent(record: NewSessionRecord): { record: SessionRecord; inserted: boolean } {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO assistant_session_registry
        (session_id, title, kind, workspace_id, created_at, archived_at, parent_session_id, origin_json,
         working_directory_kind, working_directory_path)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      record.sessionId, record.title, record.kind, record.workspaceId, record.createdAt,
      record.parentSessionId ?? null, record.origin ? JSON.stringify(record.origin) : null,
      record.workingDirectory.kind, record.workingDirectory.path,
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

  /** 清除归档时间，会话回到原工作区；未归档的会话不变。 */
  restoreSession(sessionId: string): SessionRecord | undefined {
    this.database.prepare('UPDATE assistant_session_registry SET archived_at = NULL WHERE session_id = ?')
      .run(sessionId);
    return this.getSession(sessionId);
  }

  /** 删除会话记录（仅供 E2E 重置空工作区；正常流程只归档，不删除）。 */
  deleteSessionForTest(sessionId: string): void {
    this.database.prepare('DELETE FROM assistant_session_registry WHERE session_id = ?').run(sessionId);
  }

  listAllSessions(): SessionRecord[] {
    const rows = this.database.prepare(`${SESSION_SELECT} ORDER BY r.created_at, r.session_id`)
      .all() as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  setSessionWorkingDirectory(sessionId: string, workingDirectory: WorkingDirectory): SessionRecord | undefined {
    this.database.prepare(`
      UPDATE assistant_session_registry SET working_directory_kind = ?, working_directory_path = ? WHERE session_id = ?
    `).run(workingDirectory.kind, workingDirectory.path, sessionId);
    return this.getSession(sessionId);
  }

  /** 归入项目：工作区与工作目录在同一事务中更新；只改仍在原工作区、未归档的工作会话。 */
  moveSessionToWorkspace(sessionId: string, move: SessionWorkspaceMove): SessionRecord | undefined {
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE assistant_session_registry
        SET workspace_id = ?, working_directory_kind = ?, working_directory_path = ?
        WHERE session_id = ? AND workspace_id = ? AND kind = 'work' AND archived_at IS NULL
      `).run(
        move.toWorkspaceId, move.workingDirectory.kind, move.workingDirectory.path,
        sessionId, move.fromWorkspaceId,
      );
      return result.changes === 1 ? this.getSession(sessionId) : undefined;
    });
  }

  isWorkingDirectoryRecorded(path: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM assistant_session_registry WHERE working_directory_path = ? COLLATE NOCASE LIMIT 1
    `).get(path) !== undefined;
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

  /** 存储的现场与版本；内容无法解析时现场为 undefined（由应用层回退为默认现场），版本照常返回。 */
  getWorkspaceScene(workspaceId: string): StoredWorkspaceScene | undefined {
    const row = this.database.prepare('SELECT scene_json, revision FROM workspace_scene WHERE workspace_id = ?')
      .get(workspaceId) as { scene_json: string; revision: number } | undefined;
    if (!row) return undefined;
    let scene: unknown;
    try {
      scene = JSON.parse(row.scene_json) as unknown;
    } catch {
      scene = undefined;
    }
    return { scene, revision: row.revision };
  }

  /** 保存现场并把版本加一，返回新版本；第一次保存的版本为 1。 */
  saveWorkspaceScene(workspaceId: string, scene: WorkspaceSceneState): number {
    const row = this.database.prepare(`
      INSERT INTO workspace_scene (workspace_id, scene_json, updated_at, revision) VALUES (?, ?, ?, 1)
      ON CONFLICT (workspace_id) DO UPDATE SET
        scene_json = excluded.scene_json, updated_at = excluded.updated_at, revision = workspace_scene.revision + 1
      RETURNING revision
    `).get(workspaceId, JSON.stringify(scene), this.now()) as { revision: number };
    return row.revision;
  }

  scheduleTempDirectoryCleanup(plan: NewTempDirectoryCleanupPlan): void {
    this.database.prepare(`
      INSERT INTO temp_directory_cleanup (path, directory_kind, reason, session_id, since, trashed_at, trash_path)
      VALUES (?, 'session-temp', ?, ?, ?, NULL, NULL)
      ON CONFLICT (path) DO UPDATE SET
        reason = excluded.reason, session_id = excluded.session_id, since = excluded.since,
        trashed_at = NULL, trash_path = NULL
    `).run(plan.path, plan.reason, plan.sessionId, plan.since);
  }

  getTempDirectoryCleanup(path: string): TempDirectoryCleanupPlan | undefined {
    const row = this.database.prepare('SELECT * FROM temp_directory_cleanup WHERE path = ?')
      .get(path) as unknown as TempDirectoryCleanupRow | undefined;
    return row ? cleanupPlanFromRow(row) : undefined;
  }

  listPendingTempDirectoryCleanups(): TempDirectoryCleanupPlan[] {
    const rows = this.database.prepare(`
      SELECT * FROM temp_directory_cleanup WHERE trashed_at IS NULL ORDER BY since, path
    `).all() as unknown as TempDirectoryCleanupRow[];
    return rows.map(cleanupPlanFromRow);
  }

  markTempDirectoryTrashed(path: string, trashedAt: string, trashPath: string): void {
    this.database.prepare('UPDATE temp_directory_cleanup SET trashed_at = ?, trash_path = ? WHERE path = ?')
      .run(trashedAt, trashPath, path);
  }

  removeTempDirectoryCleanup(path: string): void {
    this.database.prepare('DELETE FROM temp_directory_cleanup WHERE path = ?').run(path);
  }

  clearTempDirectoryCleanupsForTest(): void {
    this.database.exec('DELETE FROM temp_directory_cleanup');
  }

  /** 读取偏好；缺失或内容损坏时为 undefined，由应用层回退为默认值。 */
  getPreference(key: string): unknown {
    const row = this.database.prepare('SELECT value_json FROM app_preference WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }

  setPreference(key: string, value: unknown): void {
    this.database.prepare(`
      INSERT INTO app_preference (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), this.now());
  }

  clearPreferencesForTest(): void {
    this.database.exec('DELETE FROM app_preference');
  }

  getInternalToolCall(commandId: string): InternalToolCallRecord | undefined {
    const row = this.database.prepare('SELECT * FROM internal_tool_call WHERE command_id = ?')
      .get(commandId) as unknown as InternalToolCallRow | undefined;
    return row ? internalToolCallFromRow(row) : undefined;
  }

  /** 不存在时写入 running 记录；已存在时不覆盖（INSERT OR IGNORE 与读取在同一事务中）。 */
  beginInternalToolCall(
    record: Omit<InternalToolCallRecord, 'status' | 'outcome' | 'updatedAt'>,
  ): { record: InternalToolCallRecord; inserted: boolean } {
    return this.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO internal_tool_call (
          command_id, session_id, tool_call_id, tool_name, effect, arguments_fingerprint,
          status, outcome_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(
        record.commandId, record.sessionId, record.toolCallId, record.toolName, record.effect,
        record.argumentsFingerprint, record.createdAt, record.createdAt,
      ).changes > 0;
      return { record: this.getInternalToolCall(record.commandId)!, inserted };
    });
  }

  /** 只结束仍在进行中的调用；已有结果的不改写。 */
  finishInternalToolCall(commandId: string, outcome: InternalToolOutcome, updatedAt: string): void {
    this.database.prepare(`
      UPDATE internal_tool_call SET status = ?, outcome_json = ?, updated_at = ?
      WHERE command_id = ? AND status = 'running'
    `).run(outcome.ok ? 'succeeded' : 'failed', JSON.stringify(outcome), updatedAt, commandId);
  }

  getProposal(proposalId: string): ProposalRecord | undefined {
    const row = this.database.prepare('SELECT * FROM internal_tool_proposal WHERE proposal_id = ?')
      .get(proposalId) as unknown as ProposalRow | undefined;
    return row ? proposalFromRow(row) : undefined;
  }

  listProposals(sessionId: string): ProposalRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM internal_tool_proposal WHERE session_id = ? ORDER BY created_at, rowid
    `).all(sessionId) as unknown as ProposalRow[];
    return rows.map(proposalFromRow);
  }

  /** 同一会话的同一 toolCallId 已有提议时不写入，返回已有的那一张（INSERT OR IGNORE 与读取在同一事务中）。 */
  createProposal(proposal: NewProposal): { record: ProposalRecord; inserted: boolean } {
    return this.transaction(() => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO internal_tool_proposal (
          proposal_id, session_id, command_id, tool_call_id, kind, title, payload_json, preview_json, problem,
          status, outcome_json, reason, created_at, decided_at, updated_at, notified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, NULL)
      `).run(
        proposal.proposalId, proposal.sessionId, proposal.commandId, proposal.toolCallId, proposal.kind, proposal.title,
        JSON.stringify(proposal.payload ?? null), JSON.stringify(proposal.preview ?? null), proposal.problem,
        proposal.createdAt, proposal.createdAt,
      ).changes > 0;
      const row = this.database.prepare(`
        SELECT * FROM internal_tool_proposal WHERE session_id = ? AND tool_call_id = ?
      `).get(proposal.sessionId, proposal.toolCallId) as unknown as ProposalRow;
      return { record: proposalFromRow(row), inserted };
    });
  }

  /** 条件更新：只有当前状态在 from 之中时才转换；决定时间只在第一次离开待确认时写入。 */
  transitionProposal(
    proposalId: string,
    from: readonly ProposalStatus[],
    to: ProposalTransition,
  ): ProposalRecord | undefined {
    if (from.length === 0) return undefined;
    const updatedAt = this.now();
    const changed = this.database.prepare(`
      UPDATE internal_tool_proposal
      SET status = ?, outcome_json = ?, reason = ?, decided_at = COALESCE(decided_at, ?), updated_at = ?
      WHERE proposal_id = ? AND status IN (${from.map(() => '?').join(', ')})
    `).run(
      to.status, to.outcome ? JSON.stringify(to.outcome) : null, to.reason ?? null, to.decidedAt ?? updatedAt, updatedAt,
      proposalId, ...from,
    ).changes > 0;
    return changed ? this.getProposal(proposalId) : undefined;
  }

  listUnnotifiedProposals(sessionId: string): ProposalRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM internal_tool_proposal
      WHERE session_id = ? AND notified_at IS NULL AND status IN ('executed', 'cancelled', 'expired', 'failed')
      ORDER BY updated_at, rowid
    `).all(sessionId) as unknown as ProposalRow[];
    return rows.map(proposalFromRow);
  }

  markProposalsNotified(proposalIds: readonly string[], notifiedAt: string): void {
    if (proposalIds.length === 0) return;
    this.database.prepare(`
      UPDATE internal_tool_proposal SET notified_at = ?
      WHERE notified_at IS NULL AND proposal_id IN (${proposalIds.map(() => '?').join(', ')})
    `).run(notifiedAt, ...proposalIds);
  }

  failExecutingProposals(reason: string, decidedAt: string): ProposalRecord[] {
    return this.transaction(() => {
      const ids = (this.database.prepare(`
        SELECT proposal_id FROM internal_tool_proposal WHERE status = 'executing' ORDER BY updated_at, rowid
      `).all() as Array<{ proposal_id: string }>).map((row) => row.proposal_id);
      return ids.flatMap((id) => this.transitionProposal(id, ['executing'], { status: 'failed', reason, decidedAt }) ?? []);
    });
  }

  deleteAllProposalsForTest(): void {
    this.database.exec('DELETE FROM internal_tool_proposal');
  }

  listProjects(): Project[] {
    const rows = this.database.prepare('SELECT * FROM project ORDER BY created_at, project_id')
      .all() as unknown as ProjectRow[];
    return this.projectsFromRows(rows);
  }

  getProject(projectId: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM project WHERE project_id = ?')
      .get(projectId) as unknown as ProjectRow | undefined;
    return row ? this.projectsFromRows([row])[0] : undefined;
  }

  /** 项目、目录与同名工作区在同一事务中写入。 */
  createProject(record: NewProjectRecord): { project: Project; workspace: Workspace } {
    if (record.directories.length === 0) throw new Error('项目至少需要一个目录。');
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO project (project_id, name, default_constraints, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      `).run(record.projectId, record.name, record.defaultConstraints, record.createdAt, record.createdAt);
      const insertDirectory = this.database.prepare(`
        INSERT INTO project_directory (project_id, position, kind, path) VALUES (?, ?, ?, ?)
      `);
      record.directories.forEach((directory, position) => {
        insertDirectory.run(record.projectId, position, directory.kind, directory.path);
      });
      this.database.prepare(`
        INSERT INTO workspace (workspace_id, name, project_id, created_at) VALUES (?, NULL, ?, ?)
      `).run(record.projectId, record.projectId, record.createdAt);
    });
    const workspace = this.getWorkspace(record.projectId);
    if (!workspace?.project) throw new Error('项目写入后未能读取。');
    return { project: workspace.project, workspace };
  }

  /** 项目行与目录在同一事务中更新；目录给出时整体替换，顺序即 position（0 为主目录）。 */
  updateProject(projectId: string, record: ProjectUpdateRecord): { project: Project; workspace: Workspace } | undefined {
    if (record.directories?.length === 0) throw new Error('项目至少需要一个目录。');
    const updated = this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE project SET name = COALESCE(?, name), default_constraints = COALESCE(?, default_constraints), updated_at = ?
        WHERE project_id = ?
      `).run(record.name ?? null, record.defaultConstraints ?? null, record.updatedAt, projectId);
      if (result.changes === 0) return false;
      if (record.directories) {
        this.database.prepare('DELETE FROM project_directory WHERE project_id = ?').run(projectId);
        const insertDirectory = this.database.prepare(`
          INSERT INTO project_directory (project_id, position, kind, path) VALUES (?, ?, ?, ?)
        `);
        record.directories.forEach((directory, position) => {
          insertDirectory.run(projectId, position, directory.kind, directory.path);
        });
      }
      return true;
    });
    if (!updated) return undefined;
    const workspace = this.getWorkspace(projectId);
    if (!workspace?.project) throw new Error('项目更新后未能读取。');
    return { project: workspace.project, workspace };
  }

  isProjectDirectoryRecorded(path: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM project_directory WHERE path = ? COLLATE NOCASE LIMIT 1
    `).get(path) !== undefined;
  }

  /** 删除全部项目与项目工作区及其现场（仅供 E2E 重置）；默认工作区保留。 */
  deleteProjectsForTest(): void {
    this.transaction(() => {
      this.database.exec(`
        DELETE FROM workspace_scene WHERE workspace_id IN (SELECT workspace_id FROM workspace WHERE project_id IS NOT NULL);
        DELETE FROM workspace WHERE project_id IS NOT NULL;
        DELETE FROM project;
      `);
    });
  }

  /** 项目工作区按创建顺序在前，默认工作区在最后。 */
  listWorkspaces(): Workspace[] {
    const rows = this.database.prepare(`${WORKSPACE_SELECT}
      ORDER BY w.project_id IS NULL, w.created_at, w.workspace_id
    `).all() as unknown as WorkspaceRow[];
    return this.workspacesFromRows(rows);
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    const row = this.database.prepare(`${WORKSPACE_SELECT} WHERE w.workspace_id = ?`)
      .get(workspaceId) as unknown as WorkspaceRow | undefined;
    return row ? this.workspacesFromRows([row])[0] : undefined;
  }

  private workspacesFromRows(rows: readonly WorkspaceRow[]): Workspace[] {
    const projectIds = rows.flatMap((row) => row.project_id ? [row.project_id] : []);
    const projects = new Map(projectIds.map((projectId) => [projectId, this.getProject(projectId)]));
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      name: row.name,
      project: row.project_id ? projects.get(row.project_id) ?? null : null,
    }));
  }

  private projectsFromRows(rows: readonly ProjectRow[]): Project[] {
    if (rows.length === 0) return [];
    const directories = this.database.prepare(`
      SELECT project_id, kind, path FROM project_directory
      WHERE project_id IN (${rows.map(() => '?').join(', ')})
      ORDER BY project_id, position
    `).all(...rows.map((row) => row.project_id)) as unknown as ProjectDirectoryRow[];
    return rows.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      directories: directories
        .filter((directory) => directory.project_id === row.project_id)
        .map(({ kind, path }) => ({ kind, path })),
      defaultConstraints: row.default_constraints,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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

  getToolAuthorization(requestId: string): ToolAuthorizationRequest | undefined {
    const row = this.database.prepare('SELECT * FROM tool_authorization_request WHERE request_id = ?')
      .get(requestId) as unknown as ToolAuthorizationRow | undefined;
    return row ? toolAuthorizationFromRow(row) : undefined;
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
    return this.withToolAuthorizations(assistantSessionId, rows).reverse();
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
        'assistant.run.succeeded', 'assistant.run.failed', 'assistant.run.cancelled',
        'assistant.command.reconciled'
      )
      ORDER BY e.cursor
    `).all(assistantSessionId, limit, assistantSessionId) as unknown as RunTraceEventRow[];
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
        }
        continue;
      }
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

export class SqliteMessageFileSourceRepository implements MessageFileSourceRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  get(sessionId: string, piSessionId: string, entryId: string) { return this.store.getMessageFiles(sessionId, piSessionId, entryId); }
  putIfAbsent(sessionId: string, piSessionId: string, entryId: string, references: SessionFileReference[]) { this.store.putMessageFilesIfAbsent(sessionId, piSessionId, entryId, references); }
}

export class SqliteSessionRegistryRepository implements SessionRegistryRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  get(sessionId: string) { return this.store.getSession(sessionId); }
  list(workspaceId: string | null, kind: WorkspaceSessionKind, options: { includeArchived?: boolean } = {}) {
    return this.store.listSessions(workspaceId, kind, options.includeArchived ?? false);
  }
  insertIfAbsent(record: NewSessionRecord) { return this.store.insertSessionIfAbsent(record); }
  rename(sessionId: string, title: string) { return this.store.renameSession(sessionId, title); }
  archive(sessionId: string, archivedAt: string) { return this.store.archiveSession(sessionId, archivedAt); }
  restore(sessionId: string) { return this.store.restoreSession(sessionId); }
  deleteForTest(sessionId: string) { this.store.deleteSessionForTest(sessionId); }
  deleteIfUnbound(sessionId: string) { return this.store.deleteSessionIfUnbound(sessionId); }
  listAll() { return this.store.listAllSessions(); }
  setWorkingDirectory(sessionId: string, workingDirectory: WorkingDirectory) {
    return this.store.setSessionWorkingDirectory(sessionId, workingDirectory);
  }
  moveToWorkspace(sessionId: string, move: SessionWorkspaceMove) { return this.store.moveSessionToWorkspace(sessionId, move); }
  isWorkingDirectoryRecorded(path: string) { return this.store.isWorkingDirectoryRecorded(path); }
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  list() { return this.store.listProjects(); }
  get(projectId: string) { return this.store.getProject(projectId); }
  create(record: NewProjectRecord) { return this.store.createProject(record); }
  update(projectId: string, record: ProjectUpdateRecord) { return this.store.updateProject(projectId, record); }
  isDirectoryRecorded(path: string) { return this.store.isProjectDirectoryRecorded(path); }
  deleteAllForTest() { this.store.deleteProjectsForTest(); }
}

export class SqliteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  list() { return this.store.listWorkspaces(); }
  get(workspaceId: string) { return this.store.getWorkspace(workspaceId); }
}

export class SqliteWorkspaceSceneRepository implements WorkspaceSceneRepository {
  constructor(private readonly store: SqliteAssistantStore) {}
  get(workspaceId: string) { return this.store.getWorkspaceScene(workspaceId); }
  save(workspaceId: string, scene: WorkspaceSceneState) { return this.store.saveWorkspaceScene(workspaceId, scene); }
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

export class SqliteToolAuthorizationRepository implements ToolAuthorizationRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(requestId: string) { return this.store.getToolAuthorization(requestId); }
  listBySession(sessionId: string) { return this.store.listToolAuthorizations(sessionId); }
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

export class SqliteTempDirectoryCleanupRepository implements TempDirectoryCleanupRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  schedule(plan: NewTempDirectoryCleanupPlan) { this.store.scheduleTempDirectoryCleanup(plan); }
  get(path: string) { return this.store.getTempDirectoryCleanup(path); }
  listPending() { return this.store.listPendingTempDirectoryCleanups(); }
  markTrashed(path: string, trashedAt: string, trashPath: string) { this.store.markTempDirectoryTrashed(path, trashedAt, trashPath); }
  remove(path: string) { this.store.removeTempDirectoryCleanup(path); }
  clearForTest() { this.store.clearTempDirectoryCleanupsForTest(); }
}

export class SqliteInternalToolCallRepository implements InternalToolCallRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(commandId: string) { return this.store.getInternalToolCall(commandId); }
  begin(record: Omit<InternalToolCallRecord, 'status' | 'outcome' | 'updatedAt'>) {
    return this.store.beginInternalToolCall(record);
  }
  finish(commandId: string, outcome: InternalToolOutcome, updatedAt: string) {
    this.store.finishInternalToolCall(commandId, outcome, updatedAt);
  }
}

export class SqliteProposalRepository implements ProposalRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(proposalId: string) { return this.store.getProposal(proposalId); }
  listBySession(sessionId: string) { return this.store.listProposals(sessionId); }
  create(proposal: NewProposal) { return this.store.createProposal(proposal); }
  transition(proposalId: string, from: readonly ProposalStatus[], to: ProposalTransition) {
    return this.store.transitionProposal(proposalId, from, to);
  }
  listUnnotified(sessionId: string) { return this.store.listUnnotifiedProposals(sessionId); }
  markNotified(proposalIds: readonly string[], notifiedAt: string) { this.store.markProposalsNotified(proposalIds, notifiedAt); }
  failExecuting(reason: string, decidedAt: string) { return this.store.failExecutingProposals(reason, decidedAt); }
  deleteAllForTest() { this.store.deleteAllProposalsForTest(); }
}

export class SqlitePreferenceRepository implements PreferenceRepository {
  constructor(private readonly store: SqliteAssistantStore) {}

  get(key: string) { return this.store.getPreference(key); }
  set(key: string, value: unknown) { this.store.setPreference(key, value); }
  clearForTest() { this.store.clearPreferencesForTest(); }
}
