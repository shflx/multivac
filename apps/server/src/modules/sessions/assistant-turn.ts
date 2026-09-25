import type {
  AssistantCommandKind,
  AssistantCommandReceipt,
  AssistantCommandTerminalOutcome,
  AssistantPublicEvent,
} from '@multivac/contracts';

export type AssistantDispatchMode = 'prompt' | 'steer' | 'followUp' | 'abort';

export interface StoredAssistantCommandReceipt extends AssistantCommandReceipt {
  payloadFingerprint: string;
  dispatchMode: AssistantDispatchMode | null;
}

export interface CreateAssistantCommandInput {
  commandId: string;
  assistantSessionId: string;
  kind: AssistantCommandKind;
  payloadFingerprint: string;
  piSessionId: string;
}

export interface AssistantCommandEventMutation {
  receipt: StoredAssistantCommandReceipt;
  event: AssistantPublicEvent | null;
}

export interface AssistantCommandRepository {
  get(commandId: string): StoredAssistantCommandReceipt | undefined;
  listNonTerminal(assistantSessionId: string): StoredAssistantCommandReceipt[];
  /** 带 Pi entry 锚点的命令，供前端把工具执行记录放回所属 Turn。 */
  listCommandAnchors(assistantSessionId: string): AssistantCommandAnchor[];
  createAccepted(input: CreateAssistantCommandInput): AssistantCommandEventMutation;
  reject(
    commandId: string,
    error: { code: string; message: string },
  ): AssistantCommandEventMutation;
  markHandedToPi(
    commandId: string,
    dispatchMode: AssistantDispatchMode,
  ): AssistantCommandEventMutation;
  markRunning(commandId: string, piTurnRef: string | null): AssistantCommandEventMutation;
  reconcile(
    commandId: string,
    terminalOutcome: AssistantCommandTerminalOutcome,
    error?: { code: string; message: string },
    piEntryId?: string | null,
  ): AssistantCommandEventMutation;
}

export interface AppendAssistantPublicEventInput {
  sourceKey: string;
  assistantSessionId: string;
  commandId: string | null;
  type: AssistantPublicEvent['type'];
  data: AssistantPublicEvent['data'];
  occurredAt: string;
}

export type AssistantProjectionReceiptUpdate =
  | {
      type: 'running';
      commandId: string;
      piTurnRef: string | null;
    }
  | {
      type: 'terminal';
      commandId: string;
      terminalOutcome: Extract<AssistantCommandTerminalOutcome, 'succeeded' | 'failed' | 'cancelled'>;
    };

export interface AssistantProjectionMutation {
  event: AssistantPublicEvent | null;
  receipt: StoredAssistantCommandReceipt | null;
}

/** 工具事件在投影表内的最小读取形状；正文只由显式字段承载。 */
export interface ToolExecutionProjection {
  commandId: string | null;
  toolCallId: string;
  /** 该工具调用对应的事件水位（结束事件优先）。 */
  cursor: string;
  toolName: string;
  startedAt: string;
  endedAt: string | null;
  isError: boolean;
  inputText: string | null;
  inputTruncated: boolean;
}

export interface RunTraceProjection {
  commandId: string;
  cursor: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  entries: Array<
    | { kind: 'thinking'; cursor: string; text: string; truncated: boolean }
    | { kind: 'tool'; cursor: string; toolCallId: string }
  >;
  thinkingTruncated: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface AssistantCommandAnchor {
  commandId: string;
  /** 命令终结时 anchor 到的 Pi entry；用于把工具记录放回所属 Turn。 */
  piEntryId: string;
}

export interface AssistantEventRepository {
  streamingEvents?(assistantSessionId: string): AssistantPublicEvent[];
  latestCursor(): string;
  earliestCursor(): string;
  append(input: AppendAssistantPublicEventInput): AssistantPublicEvent | null;
  project(
    input: AppendAssistantPublicEventInput,
    receiptUpdate?: AssistantProjectionReceiptUpdate,
  ): AssistantProjectionMutation;
  /** cursor 全局递增；传入会话 id 时只返回该会话的事件（cursor 之间允许有间隔）。 */
  listAfter(cursor: string, limit?: number, assistantSessionId?: string): AssistantPublicEvent[];
  /** 按 toolCallId 归并，返回 before 之前最近的 limit 条，结果按 cursor 升序。 */
  toolExecutionProjections?(
    assistantSessionId: string,
    limit: number,
    before?: string,
  ): ToolExecutionProjection[];
  /** 单个工具调用的完整投影；不存在时返回 undefined。 */
  toolExecutionProjection?(
    assistantSessionId: string,
    toolCallId: string,
  ): ToolExecutionProjection | undefined;
  /** 最近命令的思考增量与运行终态投影，按 cursor 升序。 */
  runTraceProjections?(
    assistantSessionId: string,
    limit: number,
  ): RunTraceProjection[];
}

export class AssistantEventCursorExpiredError extends Error {
  constructor() {
    super('公共事件游标已失效，需要重新读取会话快照。');
    this.name = 'AssistantEventCursorExpiredError';
  }
}
