import { NoteRecordCodec, NOTE_PROTECTION_MIGRATION } from './note-record-codec.js';
import { SqliteNoteSecurityRepository, NOTE_SECURITY_MIGRATION } from './sqlite-note-security-repository.js';
import { CONTEXT_COMPACTION_MIGRATION, SqliteContextCompactionRepository } from './sqlite-context-compaction-repository.js';
import { SqliteNoteSuggestionsRepository, NOTE_SUGGESTIONS_MIGRATION } from './sqlite-note-suggestions-repository.js';
import { SqliteNoteAssistantRepository, NOTE_ASSISTANT_MIGRATION } from './sqlite-note-assistant-repository.js';
import { SqliteNotesRepository, NOTES_MIGRATION, NOTE_DELETION_MIGRATION } from './sqlite-notes-repository.js';
import { NOTE_SUMMARY_MIGRATION } from './sqlite-note-summaries.js';
import { SqliteSkillRepository, SKILL_MIGRATION } from './sqlite-skill-repository.js';
import { SqliteMcpRepository, MCP_MIGRATION } from './sqlite-mcp-repository.js';
import { READING_CONTENT_MIGRATION } from './sqlite-book-content.js';
import { SqliteUsageRepository } from './sqlite-usage-repository.js';
import { INBOX_MIGRATION, SqliteInboxRepository } from './sqlite-inbox-repository.js';
import { REMINDER_MIGRATION, SqliteReminderRepository } from './sqlite-reminder-repository.js';
import { NOTIFICATION_CHANNEL_MIGRATION } from './notification-channel-schema.js';
import { SqliteNotificationChannelRepository } from './sqlite-notification-channel-repository.js';
import { WECHAT_BINDING_MIGRATION, SqliteWechatBindingRepository } from './sqlite-wechat-binding-repository.js';
import { SqliteManagedProcessRepository, MANAGED_PROCESS_MIGRATION, MANAGED_PROCESS_COUNTS_MIGRATION } from './sqlite-managed-process-repository.js';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteNoteImagesRepository, NOTE_IMAGES_MIGRATION } from './sqlite-note-images-repository.js';
import { SqliteProjectResourceRepository, PROJECT_RESOURCE_MIGRATION } from './sqlite-project-resource-repository.js';
import { SqliteImageRepository } from './sqlite-image-repository.js';
import { SqliteTaskRepository, TASK_MIGRATION } from './sqlite-task-repository.js';
import { AGENT_MIGRATION, SqliteAgentRepository } from './sqlite-agent-repository.js';
import { SqliteTaskRunRepository, TASK_RUN_MIGRATION, TASK_RUN_OVERVIEW_MIGRATION } from './sqlite-task-run-repository.js';
import { SqliteTaskRuntimeRepository, TASK_RUNTIME_MIGRATION } from './sqlite-task-runtime-repository.js';
import { SqliteTaskFacts } from './sqlite-task-facts.js';
import {
  ASSISTANT_COMMAND_RECEIPT_MIGRATION,
  ASSISTANT_SESSION_BINDING_MIGRATION,
  IMAGE_MIGRATION,
  MESSAGE_FILE_SOURCE_MIGRATION,
  PROMPT_ANCHOR_MIGRATION,
  RUNTIME_IDENTITY_MIGRATION,
  RUNTIME_IDENTITY_RENAMES,
} from './sqlite-legacy-schema.js';
import { SqliteProjectRepository } from './sqlite-project-repository.js';
import { SqliteSessionSelectionRepository } from './sqlite-session-selection-repository.js';
import { SqliteAssistantCommandRepository } from './sqlite-assistant-command-repository.js';
import { SqliteAssistantEventRepository } from './sqlite-assistant-event-repository.js';
import { SqliteToolAuthorizationRepository } from './sqlite-tool-authorization-repository.js';
import { type EventRow, publicEventData } from './sqlite-assistant-event-rows.js';
import { SqliteProposalRepository } from './sqlite-proposal-repository.js';
import { SqliteInternalToolCallRepository } from './sqlite-internal-tool-call-repository.js';
import { SqliteTempDirectoryCleanupRepository } from './sqlite-temp-directory-cleanup-repository.js';
import { SqlitePreferenceRepository } from './sqlite-preference-repository.js';
import { SqliteSessionRegistryRepository } from './sqlite-session-registry-repository.js';
import { SqliteTerminalRepository, TERMINAL_MIGRATION } from './sqlite-terminal-repository.js';
import { SqliteWorkspaceRepository } from './sqlite-workspace-repository.js';
import { SqliteWorkspaceSceneRepository } from './sqlite-workspace-scene-repository.js';
import { SqliteAssistantBindingRepository, SqliteAssistantPageStateRepository } from './sqlite-assistant-session-repository.js';
import { SqliteMessageFileSourceRepository } from './sqlite-message-file-source-repository.js';
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
import type { AssistantPublicEvent } from '@multivac/contracts';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, GLOBAL_ASSISTANT_SESSION_ID, LEGACY_RUNTIME_IDENTITY_KEYS } from '@multivac/contracts';

// 独立标识这次迁移，后续追加迁移不会改变快照列所属的版本。
const SESSION_INITIAL_MODEL_MIGRATION = 'SELECT 1; -- session initial model snapshot';
const SESSION_AGENT_EXECUTION_MIGRATION = 'SELECT 1; -- session agent execution snapshot';

const MIGRATIONS = [
  ASSISTANT_SESSION_BINDING_MIGRATION,
  ASSISTANT_COMMAND_RECEIPT_MIGRATION,
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
  MESSAGE_FILE_SOURCE_MIGRATION,
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
  PROMPT_ANCHOR_MIGRATION,
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
  SESSION_AGENT_EXECUTION_MIGRATION,
  NOTE_SUMMARY_MIGRATION,
  SKILL_MIGRATION,
  RUNTIME_IDENTITY_MIGRATION,
  MCP_MIGRATION,
  NOTE_IMAGES_MIGRATION,
  PROJECT_RESOURCE_MIGRATION,
  TERMINAL_MIGRATION,
  CONTEXT_COMPACTION_MIGRATION,
  NOTIFICATION_CHANNEL_MIGRATION,
  WECHAT_BINDING_MIGRATION,
  NOTE_SECURITY_MIGRATION,
  NOTE_PROTECTION_MIGRATION,
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
/** 执行器会话身份中性化：列改名之后，同一事务内改写各 JSON 列中的旧字段名。 */
const RUNTIME_IDENTITY_MIGRATION_INDEX = MIGRATIONS.indexOf(RUNTIME_IDENTITY_MIGRATION);

/**
 * 各次迁移按列是否存在补充的列；ALTER TABLE 不支持 IF NOT EXISTS。
 * 列定义缺省为可空 TEXT，definition 给出时按它补充（需带默认值，存量行随之取默认值）。
 */
const COLUMN_MIGRATIONS: Readonly<Record<number, readonly { table: string; columns: readonly string[]; definition?: string }[]>> = {
  [MIGRATIONS.indexOf(NOTE_PROTECTION_MIGRATION)]: [{ table: 'app_note_command', columns: ['note_id'] }],
  [MIGRATIONS.indexOf(SESSION_INITIAL_MODEL_MIGRATION)]: [{
    table: 'assistant_session_registry',
    columns: ['initial_model_json'],
  }],
  [SESSION_PARENT_MIGRATION_INDEX]: [{
    table: 'assistant_session_registry',
    columns: ['parent_session_id', 'origin_json'],
  }],
  [SESSION_WORKING_DIRECTORY_MIGRATION_INDEX]: [{
    table: 'assistant_session_registry',
    columns: ['working_directory_kind', 'working_directory_path'],
  }],
  [TOOL_AUTHORIZATION_GRANT_MIGRATION_INDEX]: [{
    table: 'tool_authorization_request',
    columns: ['approval_scope', 'approval_source', 'grant_id', 'remember_directory', 'remember_project_id'],
  }],
  [WORKSPACE_SCENE_REVISION_MIGRATION_INDEX]: [{
    table: 'workspace_scene',
    columns: ['revision'],
    definition: 'INTEGER NOT NULL DEFAULT 0',
  }],
  [MIGRATIONS.indexOf(SESSION_AGENT_EXECUTION_MIGRATION)]: [
    { table: 'assistant_page_state', columns: ['agent_id'] },
    { table: 'assistant_command_receipt', columns: ['agent_execution_json'] },
  ],
  [MIGRATIONS.indexOf(RUNTIME_IDENTITY_MIGRATION)]: [
    { table: 'assistant_session_binding', columns: ['harness'], definition: "TEXT NOT NULL DEFAULT 'pi'" },
  ],
};

export interface SqliteAssistantStoreOptions {
  now?: () => string;
}

/** 同步 SQLite 只承担短查询和短事务，不包裹任何 Pi 或文件操作。 */
export class SqliteAssistantStore {
  readonly usage: SqliteUsageRepository;
  readonly images: SqliteImageRepository;
  readonly noteImages: SqliteNoteImagesRepository;
  readonly projectResources: SqliteProjectResourceRepository;
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
  readonly contextCompactions: SqliteContextCompactionRepository;
  readonly humanRequests: SqliteHumanRequestRepository;
  readonly inbox: SqliteInboxRepository;
  readonly reminders: SqliteReminderRepository;
  readonly notificationChannels: SqliteNotificationChannelRepository;
  readonly wechatBindings: SqliteWechatBindingRepository;
  readonly artifacts: SqliteArtifactRepository;
  readonly reading: SqliteReadingRepository;
  readonly noteCodec: NoteRecordCodec;
  readonly noteSecurity: SqliteNoteSecurityRepository;
  readonly notes: SqliteNotesRepository;
  readonly noteAssistant: SqliteNoteAssistantRepository;
  readonly noteSuggestions: SqliteNoteSuggestionsRepository;
  readonly readingNotes: SqliteReadingNotesRepository;
  readonly skills: SqliteSkillRepository;
  readonly mcp: SqliteMcpRepository;
  readonly readingCollection: SqliteReadingCollectionRepository;
  /** Multivac 会话注册表。 */
  readonly sessions: SqliteSessionRegistryRepository;
  /** 独立项目终端元数据；不保存运行期画面或 PID。 */
  readonly terminals: SqliteTerminalRepository;
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
  readonly toolAuthorizations: SqliteToolAuthorizationRepository;
  readonly events: SqliteAssistantEventRepository;
  readonly commands: SqliteAssistantCommandRepository;
  private readonly database: DatabaseSync;
  private readonly now: () => string;

  constructor(databasePath: string, options: SqliteAssistantStoreOptions = {}) {
    this.database = new DatabaseSync(databasePath);
    this.now = options.now ?? (() => new Date().toISOString());
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.backupBeforeMigration(databasePath);
      this.migrate();
      this.noteCodec = new NoteRecordCodec(this.database);
      this.contextCompactions = new SqliteContextCompactionRepository(this.database);
      this.projects = new SqliteProjectRepository(this.database, (workspaceId) => this.workspaces.get(workspaceId));
      this.selections = new SqliteSessionSelectionRepository(this.database, () => this.now());
      this.sessions = new SqliteSessionRegistryRepository(this.database);
      this.terminals = new SqliteTerminalRepository(this.database);
      this.workspaces = new SqliteWorkspaceRepository(this.database, (projectId) => this.projects.get(projectId));
      this.workspaceScenes = new SqliteWorkspaceSceneRepository(this.database, () => this.now());
      this.bindings = new SqliteAssistantBindingRepository(this.database);
      this.pageStates = new SqliteAssistantPageStateRepository(this.database, () => this.now());
      this.messageFileSources = new SqliteMessageFileSourceRepository(this.database);
      this.preferences = new SqlitePreferenceRepository(this.database, () => this.now());
      this.tempDirectoryCleanups = new SqliteTempDirectoryCleanupRepository(this.database);
      this.internalToolCalls = new SqliteInternalToolCallRepository(this.database);
      this.proposals = new SqliteProposalRepository(this.database, () => this.now());
      this.toolAuthorizations = new SqliteToolAuthorizationRepository(this.database);
      this.events = new SqliteAssistantEventRepository(this.database);
      this.commands = new SqliteAssistantCommandRepository(this.database, () => this.now());
      this.usage = new SqliteUsageRepository(this.database);
      this.inbox = new SqliteInboxRepository(this.database);
      this.reminders = new SqliteReminderRepository(this.database);
      this.notificationChannels = new SqliteNotificationChannelRepository(this.database);
      this.wechatBindings = new SqliteWechatBindingRepository(this.database);
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
      this.noteImages = new SqliteNoteImagesRepository(this.database, this.noteCodec);
      this.projectResources = new SqliteProjectResourceRepository(this.database);
      this.noteSecurity = new SqliteNoteSecurityRepository(this.database);
      this.notes = new SqliteNotesRepository(this.database, this.noteCodec);
      this.noteAssistant = new SqliteNoteAssistantRepository(this.database, this.noteCodec);
      this.noteSuggestions = new SqliteNoteSuggestionsRepository(this.database, this.noteCodec);
      this.readingNotes = new SqliteReadingNotesRepository(this.database);
      this.skills = new SqliteSkillRepository(this.database);
      this.mcp = new SqliteMcpRepository(this.database);
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
    this.database.exec('BEGIN; DELETE FROM notification_wechat_binding; DELETE FROM notification_delivery_attempt; DELETE FROM notification_delivery; DELETE FROM notification_channel_range; DELETE FROM notification_channel_command; DELETE FROM notification_channel; DELETE FROM reminder_command; DELETE FROM inbox_notification; DELETE FROM reminder_timer; DELETE FROM reminder; DELETE FROM inbox_state; DELETE FROM inbox_external; DELETE FROM inbox_command; DELETE FROM task_artifact_version; DELETE FROM task_human_request; DELETE FROM task_run; DELETE FROM task_event; DELETE FROM task_command; DELETE FROM task_dependency; DELETE FROM task; DELETE FROM task_group; COMMIT;');
  }

  private appliedVersion(): number {
    const hasTable = this.database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (!hasTable) return 0;
    return (this.database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number }).version;
  }

  /**
   * 已有数据的库在执行新迁移前先完整备份到同目录（`<库文件>.v<旧版本>-<时间>.bak`）。
   * 迁移后的库不能被旧版本读取；回退版本时用备份恢复。新建的库与内存库不备份。
   */
  private backupBeforeMigration(databasePath: string): void {
    if (databasePath === ':memory:' || databasePath === '') return;
    const version = this.appliedVersion();
    if (version === 0 || version >= MIGRATIONS.length) return;
    const stamp = new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14);
    let target = `${databasePath}.v${version}-${stamp}.bak`;
    for (let copy = 1; existsSync(target); copy += 1) target = `${databasePath}.v${version}-${stamp}-${copy}.bak`;
    this.database.prepare('VACUUM INTO ?').run(target);
  }

  /** 执行器身份列按旧列是否存在逐列改名，已是新名的库跳过。 */
  private renameRuntimeIdentityColumns(): void {
    for (const { table, from, to } of RUNTIME_IDENTITY_RENAMES) {
      const columns = new Set((this.database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
        .map((column) => column.name));
      if (columns.has(from) && !columns.has(to)) this.database.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    }
  }

  /** 把各表 JSON 列（以及图片来源）中的旧身份字段名换成现名；只匹配 JSON 键，正文里的字符串已转义不会命中。 */
  private rewriteLegacyIdentityKeys(): void {
    const tables = (this.database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of tables) {
      const columns = (this.database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((column) => column.endsWith('_json') || (table === 'message_image_source' && column === 'sources'));
      for (const column of columns) {
        for (const [legacy, current] of Object.entries(LEGACY_RUNTIME_IDENTITY_KEYS)) {
          this.database.prepare(`UPDATE "${table}" SET "${column}" = replace("${column}", ?, ?) WHERE instr("${column}", ?) > 0`)
            .run(`"${legacy}":`, `"${current}":`, `"${legacy}":`);
        }
      }
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
        if (index === RUNTIME_IDENTITY_MIGRATION_INDEX) this.renameRuntimeIdentityColumns();
        for (const columnMigration of COLUMN_MIGRATIONS[index] ?? []) {
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
        if (index === RUNTIME_IDENTITY_MIGRATION_INDEX) this.rewriteLegacyIdentityKeys();
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
