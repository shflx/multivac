import type { DatabaseSync } from 'node:sqlite';
import { SqliteInternalToolCallRepository } from './sqlite-internal-tool-call-repository.js';

/** 子级身份只归属委派运行，不要求注册普通会话。 */
export const SUBAGENT_TOOL_CALL_MIGRATION = `
  CREATE TABLE IF NOT EXISTS subagent_tool_call (
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
    FOREIGN KEY (session_id) REFERENCES subagent_run(session_id) ON DELETE CASCADE
  ) STRICT;
`;

/** 与普通账本共用登记、终结和历史回执解码语义，独立维护外键归属。 */
export class SqliteSubagentToolCallRepository extends SqliteInternalToolCallRepository {
  constructor(database: DatabaseSync) { super(database, 'subagent_tool_call'); }
}
