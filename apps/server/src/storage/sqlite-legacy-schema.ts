/**
 * 执行器会话身份中性化之前的历史迁移原文。
 *
 * 这些迁移以 Pi 命名创建过列（pi_session_id 等）；已部署的数据库按版本号重放过它们，
 * 原文必须保持不变，否则新库与旧库的结构会出现分歧。之后由 RUNTIME_IDENTITY_MIGRATION 统一改为中性命名。
 * 新代码不得引用这里的旧列名。
 */

export const ASSISTANT_SESSION_BINDING_MIGRATION = `
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
  `;

export const ASSISTANT_COMMAND_RECEIPT_MIGRATION = `
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
  `;

export const MESSAGE_FILE_SOURCE_MIGRATION = `
    CREATE TABLE IF NOT EXISTS assistant_message_file_source (
      session_id TEXT NOT NULL,
      pi_session_id TEXT NOT NULL,
      pi_entry_id TEXT NOT NULL,
      references_json TEXT NOT NULL,
      PRIMARY KEY (session_id, pi_session_id, pi_entry_id)
    ) STRICT;
  `;

export const PROMPT_ANCHOR_MIGRATION = `CREATE TABLE IF NOT EXISTS assistant_prompt_anchor (
    command_id TEXT PRIMARY KEY REFERENCES assistant_command_receipt(command_id) ON DELETE CASCADE,
    baseline_pi_entry_id TEXT,
    user_pi_entry_id TEXT
  ) STRICT;`;

export const IMAGE_MIGRATION = `CREATE TABLE IF NOT EXISTS image_attachment (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL, retained INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS message_image_source (session_id TEXT NOT NULL, pi_session_id TEXT NOT NULL, entry_id TEXT NOT NULL, sources TEXT NOT NULL, PRIMARY KEY (session_id, pi_session_id, entry_id));`;

/**
 * 执行器会话身份中性化：Pi 命名的列改为与 harness 无关的命名，绑定记录增加 harness（存量都是 Pi 会话）。
 * runtime_session_ref 是由所属 harness 解释的会话引用；对 Pi 而言即会话文件路径。
 * 改名由 SqliteAssistantStore 按旧列是否存在逐列执行，重放与中途中断后重试都不会失败。
 */
export const RUNTIME_IDENTITY_MIGRATION = 'SELECT 1; -- runtime identity';

export const RUNTIME_IDENTITY_RENAMES: readonly { table: string; from: string; to: string }[] = [
  { table: 'assistant_session_binding', from: 'pi_session_id', to: 'runtime_session_id' },
  { table: 'assistant_session_binding', from: 'pi_session_path', to: 'runtime_session_ref' },
  { table: 'assistant_command_receipt', from: 'pi_session_id', to: 'runtime_session_id' },
  { table: 'assistant_command_receipt', from: 'pi_entry_id', to: 'runtime_entry_id' },
  { table: 'assistant_command_receipt', from: 'pi_turn_ref', to: 'runtime_turn_ref' },
  { table: 'assistant_message_file_source', from: 'pi_session_id', to: 'runtime_session_id' },
  { table: 'assistant_message_file_source', from: 'pi_entry_id', to: 'runtime_entry_id' },
  { table: 'assistant_prompt_anchor', from: 'baseline_pi_entry_id', to: 'baseline_runtime_entry_id' },
  { table: 'assistant_prompt_anchor', from: 'user_pi_entry_id', to: 'user_runtime_entry_id' },
  { table: 'message_image_source', from: 'pi_session_id', to: 'runtime_session_id' },
];
