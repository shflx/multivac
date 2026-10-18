import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from './sqlite-transaction.js';
import { AssistantToolResultSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { migrateLegacyManagementReceipt } from './legacy-management-receipt.js';
import type { InternalToolCallRecord, InternalToolCallRepository, InternalToolCallStatus, InternalToolOutcome } from '../modules/internal-tools/internal-tool.js';

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

/**
 * 内部工具调用记录的 SQLite 实现：按命令幂等登记，只结束仍在进行中的调用。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteInternalToolCallRepository implements InternalToolCallRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(commandId: string): InternalToolCallRecord | undefined {
    const row = this.database.prepare('SELECT * FROM internal_tool_call WHERE command_id = ?')
      .get(commandId) as unknown as InternalToolCallRow | undefined;
    return row ? internalToolCallFromRow(row) : undefined;
  }

  /** 不存在时写入 running 记录；已存在时不覆盖（INSERT OR IGNORE 与读取在同一事务中）。 */
  begin(
    record: Omit<InternalToolCallRecord, 'status' | 'outcome' | 'updatedAt'>,
  ): { record: InternalToolCallRecord; inserted: boolean } {
    return runInTransaction(this.database, () => {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO internal_tool_call (
          command_id, session_id, tool_call_id, tool_name, effect, arguments_fingerprint,
          status, outcome_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(
        record.commandId, record.sessionId, record.toolCallId, record.toolName, record.effect,
        record.argumentsFingerprint, record.createdAt, record.createdAt,
      ).changes > 0;
      return { record: this.get(record.commandId)!, inserted };
    });
  }

  /** 只结束仍在进行中的调用；已有结果的不改写。 */
  finish(commandId: string, outcome: InternalToolOutcome, updatedAt: string): void {
    this.database.prepare(`
      UPDATE internal_tool_call SET status = ?, outcome_json = ?, updated_at = ?
      WHERE command_id = ? AND status = 'running'
    `).run(outcome.ok ? 'succeeded' : 'failed', JSON.stringify(outcome), updatedAt, commandId);
  }
}
