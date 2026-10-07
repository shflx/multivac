import type {
  CoordinatorAdapterEvent,
  CoordinatorRunResult,
  CoordinatorRunStatus,
  CoordinatorUsage,
} from '@multivac/contracts';
import {
  AssistantToolResultSchema,
  assistantExecutionError,
  type AssistantExecutionError,
  assistantToolKeyArgument,
  truncateAssistantToolInput,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export const IGNORED_PI_EVENT_TYPES = new Set([
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'bash_execution_update',
  'summarization_retry_attempt_start',
]);

interface EventMapperInput {
  initialMessageIds?: readonly string[];
  assistantSessionId: string;
  piSessionId: string;
  sourceInstanceId: string;
  now?: () => string;
  initialSequence?: number;
  /** 本会话注入的内部工具；只有它们成功时的公开结果（契约白名单）会随结束事件转发。 */
  internalToolNames?: readonly string[];
}

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUsage(value: unknown): value is UsageLike {
  if (!isRecord(value) || !isRecord(value.cost)) {
    return false;
  }

  return (
    typeof value.input === 'number' &&
    typeof value.output === 'number' &&
    typeof value.cacheRead === 'number' &&
    typeof value.cacheWrite === 'number' &&
    typeof value.totalTokens === 'number' &&
    typeof value.cost.input === 'number' &&
    typeof value.cost.output === 'number' &&
    typeof value.cost.cacheRead === 'number' &&
    typeof value.cost.cacheWrite === 'number' &&
    typeof value.cost.total === 'number'
  );
}

export function normalizePiUsage(value: unknown): CoordinatorUsage | undefined {
  if (!isUsage(value)) {
    return undefined;
  }

  return {
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    ...(typeof value.reasoning === 'number' ? { reasoningTokens: value.reasoning } : {}),
    totalTokens: value.totalTokens,
    cost: { ...value.cost },
  };
}

function messageRole(message: unknown): 'user' | 'assistant' | 'tool' {
  if (!isRecord(message)) {
    return 'assistant';
  }

  if (message.role === 'user') {
    return 'user';
  }

  if (message.role === 'toolResult') {
    return 'tool';
  }

  return 'assistant';
}

function messageId(message: unknown): string {
  if (!isRecord(message)) {
    return 'assistant:unknown';
  }

  if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
    return `tool:${message.toolCallId}`;
  }

  const role = typeof message.role === 'string' ? message.role : 'assistant';
  const timestamp = typeof message.timestamp === 'number' ? message.timestamp : 'unknown';
  return `${role}:${timestamp}`;
}

function messageUsage(message: unknown): CoordinatorUsage | undefined {
  return isRecord(message) ? normalizePiUsage(message.usage) : undefined;
}

function messageStopReason(message: unknown): string | undefined {
  return isRecord(message) && typeof message.stopReason === 'string' ? message.stopReason : undefined;
}

function argumentKeys(args: unknown): string[] {
  return isRecord(args) ? Object.keys(args).sort() : [];
}

const TOOL_ARG_VALUE_MAX_BYTES = 24 * 1024;

/** 工具入参可能包含服务端凭据，投影前先移除常见凭据形态。 */
const CREDENTIAL_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gu,
  /\b(?:sk|rk|pk|api[_-]?key)[-_][A-Za-z0-9._-]{8,}/giu,
] as const;

function redactCredentials(text: string): string {
  return CREDENTIAL_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[已隐藏凭据]'),
    text,
  );
}

function capText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  const slice = Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
  // subarray 可能截断多字节字符，替换尾部残码后再标记截断。
  return `${slice.replace(/\uFFFD+$/u, '')}\n…（内容过长，已截断）`;
}

function toolArgumentValue(key: string, value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `${key}: ${capText(text ?? String(value), TOOL_ARG_VALUE_MAX_BYTES)}`;
}

/**
 * 工具入参按参数列表投影，正文截断在持久化和 SSE 之前完成。
 * 关键参数固定排在首行：入参顺序由模型决定，长正文在前时关键参数可能被整体截断。
 */
function toolInputProjection(toolName: string, args: unknown): { text: string; truncated: boolean } {
  const keyArgument = assistantToolKeyArgument(toolName);
  const entries = isRecord(args)
    ? Object.entries(args).sort(([left], [right]) => Number(right === keyArgument) - Number(left === keyArgument))
    : [];
  const text = isRecord(args)
    ? entries.map(([key, value]) => toolArgumentValue(key, value)).join('\n')
    : args === undefined || args === null ? '' : String(args);
  return truncateAssistantToolInput(redactCredentials(text));
}

export function toolInputText(toolName: string, args: unknown): string {
  return toolInputProjection(toolName, args).text;
}

/** Pi 原始对象只在映射器内部读取，公共未知事件只保留类型和顺序。 */
export class PiCoordinatorEventMapper {
  private readonly messageCounts = new Map<string, number>();
  private activeAssistantMessageId: string | undefined;
  private sequence: number;
  private lastRunStatus: CoordinatorRunStatus = 'completed';
  private lastError: AssistantExecutionError | undefined;
  private lastUsage: CoordinatorUsage | undefined;
  private lastRunResult: CoordinatorRunResult | undefined;
  private lastSummarizationRetryAttempt = 0;
  /** 本轮已请求中止；新一轮开始时清除。 */
  private abortRequested = false;
  private readonly now: () => string;

  constructor(private readonly input: EventMapperInput) {
    for (const id of input.initialMessageIds ?? []) {
      this.messageCounts.set(id, (this.messageCounts.get(id) ?? 0) + 1);
    }
    this.sequence = input.initialSequence ?? 0;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  getLastRunResult(): CoordinatorRunResult | undefined {
    return this.lastRunResult;
  }

  /**
   * 记下本轮已请求中止。中止发生在工具执行期间（例如运行命令或等待授权）时，Pi 在工具之后才发起的
   * 模型请求会以 error 结束（provider 报告请求已中止），而不是 aborted；这种情况按取消处理。
   */
  markAbortRequested(): void {
    this.abortRequested = true;
  }

  isAbortRequested(): boolean {
    return this.abortRequested;
  }

  resetRunResult(): void {
    this.abortRequested = false;
    this.lastRunStatus = 'completed';
    this.lastError = undefined;
    this.lastUsage = undefined;
    this.lastRunResult = undefined;
    this.lastSummarizationRetryAttempt = 0;
  }

  map(rawEvent: AgentSessionEvent | { type: string }): CoordinatorAdapterEvent | null {
    const sourceType = rawEvent.type;

    if (IGNORED_PI_EVENT_TYPES.has(sourceType)) {
      return null;
    }

    const event = rawEvent as AgentSessionEvent;

    switch (event.type) {
      case 'agent_start':
        this.resetRunResult();
        return { ...this.nextBase(), type: 'coordinator.run.started' };
      case 'agent_end':
        return {
          ...this.nextBase(),
          type: 'coordinator.run.ended',
          willRetry: event.willRetry,
        };
      case 'agent_settled': {
        this.lastRunResult = {
          status: this.lastRunStatus,
          ...(this.lastRunStatus === 'failed' && this.lastError ? { error: this.lastError } : {}),
          ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };

        const type =
          this.lastRunStatus === 'cancelled'
            ? 'coordinator.run.cancelled'
            : this.lastRunStatus === 'failed'
              ? 'coordinator.run.failed'
              : 'coordinator.run.completed';

        return {
          ...this.nextBase(),
          type,
          ...(type === 'coordinator.run.failed' && this.lastError ? { error: this.lastError } : {}),
          ...(this.lastUsage === undefined ? {} : { usage: this.lastUsage }),
        };
      }
      case 'turn_start':
        return { ...this.nextBase(), type: 'coordinator.turn.started' };
      case 'turn_end': {
        const usage = messageUsage(event.message);
        this.captureMessageOutcome(event.message);
        return {
          ...this.nextBase(),
          type: 'coordinator.turn.ended',
          ...(usage === undefined ? {} : { usage }),
        };
      }
      case 'message_start':
        return {
          ...this.nextBase(),
          type: 'coordinator.message.started',
          messageId: this.identifyMessage(event.message, true),
          role: messageRole(event.message),
        };
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent.type !== 'text_delta' && assistantEvent.type !== 'thinking_delta') {
          return null;
        }

        return {
          ...this.nextBase(),
          type: 'coordinator.message.delta',
          messageId: this.identifyMessage(event.message),
          channel: assistantEvent.type === 'text_delta' ? 'text' : 'thinking',
          delta: assistantEvent.delta,
        };
      }
      case 'message_end': {
        const message = event.message;
        const usage = messageUsage(message);
        const stopReason = messageStopReason(message);
        this.captureMessageOutcome(message);
        return {
          ...this.nextBase(),
          type: 'coordinator.message.ended',
          messageId: this.identifyMessage(message),
          role: messageRole(message),
          ...(stopReason === undefined ? {} : { stopReason }),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      case 'tool_execution_start': {
        const input = toolInputProjection(event.toolName, event.args);
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argumentKeys: argumentKeys(event.args),
          inputText: input.text,
          inputTruncated: input.truncated,
        };
      }
      case 'tool_execution_update':
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.updated',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
      case 'tool_execution_end': {
        // 工具结果正文不公开；内部工具成功时只转发通过契约校验的结果摘要与对象。
        const details: unknown = isRecord(event.result) ? event.result.details : undefined;
        const publicResult = !event.isError && this.input.internalToolNames?.includes(event.toolName) &&
          Check(AssistantToolResultSchema, details)
          ? details
          : undefined;
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.ended',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          ...(publicResult ? { result: publicResult } : {}),
        };
      }
      case 'queue_update':
        return {
          ...this.nextBase(),
          type: 'coordinator.queue.updated',
          steeringCount: event.steering.length,
          followUpCount: event.followUp.length,
        };
      case 'auto_retry_start':
        return {
          ...this.nextBase(),
          type: 'coordinator.retry.started',
          scope: 'run',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        };
      case 'auto_retry_end':
        this.captureRetryOutcome(event.success, event.finalError);
        return {
          ...this.nextBase(),
          type: 'coordinator.retry.ended',
          scope: 'run',
          outcome: this.retryOutcome(event.success, event.finalError),
          attempt: event.attempt,
        };
      case 'summarization_retry_scheduled':
        this.lastSummarizationRetryAttempt = event.attempt;
        return {
          ...this.nextBase(),
          type: 'coordinator.retry.started',
          scope: 'summarization',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        };
      case 'summarization_retry_finished':
        return {
          ...this.nextBase(),
          type: 'coordinator.retry.ended',
          scope: 'summarization',
          outcome: 'unknown',
          attempt: this.lastSummarizationRetryAttempt,
        };
      case 'compaction_start':
        return {
          ...this.nextBase(),
          type: 'coordinator.compaction.started',
          reason: event.reason,
        };
      case 'compaction_end':
        const compactionStatus = event.aborted
          ? 'cancelled'
          : event.result
            ? 'succeeded'
            : 'failed';
        return {
          ...this.nextBase(),
          type: 'coordinator.compaction.ended',
          reason: event.reason,
          status: compactionStatus,
          willRetry: event.willRetry,
          ...(compactionStatus === 'failed' ? { errorCode: 'COMPACTION_FAILED' as const } : {}),
        };
      default:
        return {
          ...this.nextBase(),
          type: 'coordinator.unknown',
          sourceType,
        };
    }
  }

  private captureMessageOutcome(message: unknown): void {
    const usage = messageUsage(message);
    const stopReason = messageStopReason(message);

    if (usage) {
      this.lastUsage = usage;
    }

    if (stopReason === 'aborted' || (stopReason === 'error' && this.abortRequested)) {
      this.lastRunStatus = 'cancelled';
      this.lastError = undefined;
    } else if (stopReason === 'error') {
      this.lastRunStatus = 'failed';
      this.lastError = assistantExecutionError('MODEL_REQUEST_FAILED', isRecord(message) ? message.errorMessage : undefined);
    } else if (stopReason) {
      this.lastRunStatus = 'completed';
      this.lastError = undefined;
    }
  }

  private identifyMessage(message: unknown, started = false): string {
    const base = messageId(message);
    if (messageRole(message) !== 'assistant') return base;
    if (started || !this.activeAssistantMessageId) {
      const count = (this.messageCounts.get(base) ?? 0) + 1;
      this.messageCounts.set(base, count);
      this.activeAssistantMessageId = count === 1 ? base : `${base}:${count}`;
    }
    return this.activeAssistantMessageId;
  }

  private captureRetryOutcome(success: boolean, finalError: string | undefined): void {
    const outcome = this.retryOutcome(success, finalError);
    if (outcome === 'cancelled') {
      this.lastRunStatus = 'cancelled';
      this.lastError = undefined;
    } else if (outcome === 'failed') {
      this.lastRunStatus = 'failed';
      this.lastError = assistantExecutionError('MODEL_REQUEST_FAILED', finalError) ?? this.lastError;
    } else if (outcome === 'succeeded') {
      this.lastRunStatus = 'completed';
      this.lastError = undefined;
    }
  }

  private retryOutcome(
    success: boolean,
    finalError: string | undefined,
  ): 'succeeded' | 'failed' | 'cancelled' {
    if (success) {
      return 'succeeded';
    }

    return finalError === 'Retry cancelled' ? 'cancelled' : 'failed';
  }

  private nextBase() {
    this.sequence += 1;
    const cursor = `${this.input.piSessionId}:${this.input.sourceInstanceId}:${this.sequence}`;

    return {
      eventId: cursor,
      cursor,
      sequence: this.sequence,
      sourceInstanceId: this.input.sourceInstanceId,
      assistantSessionId: this.input.assistantSessionId,
      piSessionId: this.input.piSessionId,
      occurredAt: this.now(),
    };
  }
}
