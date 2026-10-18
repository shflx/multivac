import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { type ToolAuthorizationRow, approvalFromColumns } from './sqlite-tool-authorization-repository.js';
import { type EventRow, eventFromRow, appendEventRow, readCommand, requireCommand } from './sqlite-assistant-event-rows.js';
import { toolResultFromJson } from './sqlite-tool-result-column.js';
import { runInTransaction } from './sqlite-transaction.js';
import type { AssistantCommandTerminalOutcome, AssistantPublicEvent } from '@multivac/contracts';
import { truncateAssistantThinkingTrace } from '@multivac/contracts';
import {
  AssistantEventCursorExpiredError,
  type AppendAssistantPublicEventInput,
  type AssistantEventRepository,
  type AssistantProjectionMutation,
  type AssistantProjectionReceiptUpdate,
  type RunTraceProjection,
  type ToolExecutionProjection,
} from '../modules/sessions/assistant-turn.js';

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

/**
 * 公开事件投影的 SQLite 实现：按游标续读、正文流恢复、工具执行与运行轨迹投影；
 * 投影事件与命令收据推进在同一事务中提交。
 * 表结构与迁移由 SqliteAssistantStore 维护。
 */
export class SqliteAssistantEventRepository implements AssistantEventRepository {
  constructor(private readonly database: DatabaseSync) {}

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
    return runInTransaction(this.database, () => appendEventRow(this.database, input));
  }

  project(
    input: AppendAssistantPublicEventInput,
    receiptUpdate?: AssistantProjectionReceiptUpdate,
  ): AssistantProjectionMutation {
    return runInTransaction(this.database, () => {
      const event = appendEventRow(this.database, input);
      if (!event || !receiptUpdate) {
        return {
          event,
          receipt: receiptUpdate ? readCommand(this.database, receiptUpdate.commandId) ?? null : null,
        };
      }

      const current = requireCommand(this.database, receiptUpdate.commandId);
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

      return { event, receipt: requireCommand(this.database, receiptUpdate.commandId) };
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
        ...(readCommand(this.database, row.command_id)?.executor ? { executor: readCommand(this.database, row.command_id)!.executor } : {}),
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
}
