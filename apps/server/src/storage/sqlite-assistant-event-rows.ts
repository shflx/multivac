import { noteCodecFor } from './note-record-codec.js';
/**
 * 命令收据与公开事件的行解析和事件写入：命令、事件与工具授权仓储在各自事务内共用，
 * 保证收据、授权状态与对应事件一起提交。
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  AssistantCommandKind,
  AssistantCommandStatus,
  AssistantCommandTerminalOutcome,
  AssistantPublicEvent,
} from '@multivac/contracts';
import {
  assistantExecutionError,
  AssistantToolResultSchema,
  truncateAssistantThinkingDelta,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import { migrateLegacyManagementReceipt } from './legacy-management-receipt.js';
import type { AppendAssistantPublicEventInput, AssistantDispatchMode, StoredAssistantCommandReceipt } from '../modules/sessions/assistant-turn.js';

export interface CommandRow {
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
  runtime_session_id: string | null;
  runtime_entry_id: string | null;
  runtime_turn_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  cursor: number;
  assistant_id: string;
  command_id: string | null;
  event_type: AssistantPublicEvent['type'];
  payload_json: string;
  source_key?: string;
  occurred_at: string;
}

export function commandFromRow(row: CommandRow, database?: DatabaseSync): StoredAssistantCommandReceipt {
  const codec = database && noteCodecFor(database), owner = codec && codec.owner(row.assistant_id);
  const message = row.error_message && owner && codec?.state(owner) ? codec.decode<string>(owner, 'command-error', row.command_id, row.error_message) : row.error_message;
  return {
    commandId: row.command_id,
    assistantSessionId: row.assistant_id,
    kind: row.kind,
    payloadFingerprint: row.payload_fingerprint,
    ...(row.agent_execution_json ? { agentExecution: JSON.parse(row.agent_execution_json), executor: JSON.parse(row.agent_execution_json).executor } : {}),
    dispatchMode: row.dispatch_mode,
    status: row.phase,
    terminalOutcome: row.terminal_outcome,
    error: row.error_code && message
      ? assistantExecutionError(row.error_code, message) ?? null
      : null,
    runtimeSessionId: row.runtime_session_id,
    runtimeEntryId: row.runtime_entry_id,
    runtimeTurnRef: row.runtime_turn_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function publicEventData(type: AssistantPublicEvent['type'], data: AssistantPublicEvent['data']): AssistantPublicEvent['data'] {
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
      runtimeSessionId: thinking.runtimeSessionId,
      messageId: thinking.messageId,
      delta: delta.text,
      deltaTruncated: thinking.deltaTruncated === true || delta.truncated,
    };
  }
  return data;
}

export function eventFromRow(row: EventRow, database?: DatabaseSync): AssistantPublicEvent {
  return {
    cursor: String(row.cursor),
    eventId: `assistant-event:${row.cursor}`,
    assistantSessionId: row.assistant_id,
    commandId: row.command_id,
    type: row.event_type,
    data: publicEventData(row.event_type, (() => {
      const codec = database && noteCodecFor(database), owner = codec && codec.owner(row.assistant_id);
      return owner && codec?.state(owner) ? codec.decode(owner, 'event', row.source_key!, row.payload_json) : JSON.parse(row.payload_json);
    })() as AssistantPublicEvent['data']),
    occurredAt: row.occurred_at,
  } as AssistantPublicEvent;
}

/** 按来源键幂等追加公开事件；已存在时返回 null。调用方负责事务。 */
export function appendEventRow(database: DatabaseSync, input: AppendAssistantPublicEventInput): AssistantPublicEvent | null {
  const codec = noteCodecFor(database), owner = codec?.owner(input.assistantSessionId);
  const data = publicEventData(input.type, input.data);
  const payload = owner && codec ? codec.encode(owner, 'event', input.sourceKey, data) : JSON.stringify(data);
  const result = database.prepare(`
    INSERT OR IGNORE INTO assistant_event_projection (
      source_key, assistant_id, command_id, event_type, payload_json, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.sourceKey,
    input.assistantSessionId,
    input.commandId,
    input.type,
    payload,
    input.occurredAt,
  );
  if (result.changes === 0) return null;
  const row = database.prepare(`
    SELECT source_key, cursor, assistant_id, command_id, event_type, payload_json, occurred_at
    FROM assistant_event_projection WHERE source_key = ?
  `).get(input.sourceKey) as unknown as EventRow;
  return eventFromRow(row, database);
}

export function readCommand(database: DatabaseSync, commandId: string): StoredAssistantCommandReceipt | undefined {
  const row = database.prepare(`
    SELECT * FROM assistant_command_receipt WHERE command_id = ?
  `).get(commandId) as unknown as CommandRow | undefined;
  return row ? commandFromRow(row, database) : undefined;
}

export function requireCommand(database: DatabaseSync, commandId: string): StoredAssistantCommandReceipt {
  const receipt = readCommand(database, commandId);
  if (!receipt) throw new Error(`Multivac 命令不存在：${commandId}`);
  return receipt;
}
