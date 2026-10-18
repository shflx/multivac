import type { DatabaseSync } from 'node:sqlite';
import { type CommandRow, commandFromRow, appendEventRow, readCommand, requireCommand } from './sqlite-assistant-event-rows.js';
import { runInTransaction } from './sqlite-transaction.js';
import type { AssistantCommandTerminalOutcome } from '@multivac/contracts';
import { assistantExecutionError } from '@multivac/contracts';
import type {
  AssistantCommandEventMutation,
  AssistantCommandRepository,
  AssistantDispatchMode,
  CreateAssistantCommandInput,
  StoredAssistantCommandReceipt,
  AssistantCommandAnchor,
} from '../modules/sessions/assistant-turn.js';

/**
 * 命令收据与提示锚点的 SQLite 实现：收据阶段推进与对应的公开事件在同一事务中提交。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteAssistantCommandRepository implements AssistantCommandRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => string) {}

  get(commandId: string): StoredAssistantCommandReceipt | undefined {
    return readCommand(this.database, commandId);
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
    return runInTransaction(this.database, () => {
      const existing = readCommand(this.database, input.commandId);
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
      const event = appendEventRow(this.database, {
        sourceKey: `command:${input.commandId}:accepted`,
        assistantSessionId: input.assistantSessionId,
        commandId: input.commandId,
        type: 'assistant.command.accepted',
        data: { kind: input.kind, ...(input.agentExecution ? { executor: input.agentExecution.executor } : {}) },
        occurredAt: now,
      });
      return { receipt: requireCommand(this.database, input.commandId), event };
    });
  }

  reject(commandId: string, error: { code: string; message: string }): AssistantCommandEventMutation {
    return runInTransaction(this.database, () => {
      error = assistantExecutionError(error.code, error.message) ?? { code: 'RUNTIME_OPERATION_FAILED', message: '原因未提供。' };
      const current = requireCommand(this.database, commandId);
      if (current.status === 'terminal') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'terminal', terminal_outcome = 'rejected', error_code = ?, error_message = ?, updated_at = ?
        WHERE command_id = ? AND phase != 'terminal'
      `).run(error.code, error.message, now, commandId);
      const event = appendEventRow(this.database, {
        sourceKey: `command:${commandId}:rejected`,
        assistantSessionId: current.assistantSessionId,
        commandId,
        type: 'assistant.command.rejected',
        data: { error },
        occurredAt: now,
      });
      return { receipt: requireCommand(this.database, commandId), event };
    });
  }

  markHandedToPi(
    commandId: string,
    dispatchMode: AssistantDispatchMode,
  ): AssistantCommandEventMutation {
    return runInTransaction(this.database, () => {
      const current = requireCommand(this.database, commandId);
      if (current.status !== 'accepted') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'handed_to_pi', dispatch_mode = ?, updated_at = ?
        WHERE command_id = ? AND phase = 'accepted'
      `).run(dispatchMode, now, commandId);
      const event = appendEventRow(this.database, {
        sourceKey: `command:${commandId}:handed`,
        assistantSessionId: current.assistantSessionId,
        commandId,
        type: 'assistant.command.handed_to_pi',
        data: { kind: current.kind, dispatchMode },
        occurredAt: now,
      });
      return { receipt: requireCommand(this.database, commandId), event };
    });
  }

  markRunning(commandId: string, piTurnRef: string | null): AssistantCommandEventMutation {
    return runInTransaction(this.database, () => {
      const current = requireCommand(this.database, commandId);
      if (current.status === 'terminal') return { receipt: current, event: null };
      const now = this.now();
      this.database.prepare(`
        UPDATE assistant_command_receipt
        SET phase = 'running', pi_turn_ref = COALESCE(pi_turn_ref, ?), updated_at = ?
        WHERE command_id = ? AND phase != 'terminal'
      `).run(piTurnRef, now, commandId);
      return { receipt: requireCommand(this.database, commandId), event: null };
    });
  }

  reconcile(
    commandId: string,
    terminalOutcome: AssistantCommandTerminalOutcome,
    error?: { code: string; message: string },
    piEntryId?: string | null,
  ): AssistantCommandEventMutation {
    return runInTransaction(this.database, () => {
      const current = requireCommand(this.database, commandId);
      error = error ? assistantExecutionError(error.code, error.message) : undefined;
      if (current.status === 'terminal') {
        if (piEntryId && !current.piEntryId) {
          this.database.prepare(`
            UPDATE assistant_command_receipt
            SET pi_entry_id = ?, updated_at = ?
            WHERE command_id = ? AND pi_entry_id IS NULL
          `).run(piEntryId, this.now(), commandId);
          return { receipt: requireCommand(this.database, commandId), event: null };
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
      const receipt = requireCommand(this.database, commandId);
      const event = appendEventRow(this.database, {
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
}
