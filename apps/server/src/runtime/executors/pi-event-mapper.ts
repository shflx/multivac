import type {
  CoordinatorAdapterEvent,
  CoordinatorRunResult,
  CoordinatorRunStatus,
  CoordinatorUsage,
} from '@multivac/contracts';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export const IGNORED_PI_EVENT_TYPES = new Set([
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'bash_execution_update',
  'summarization_retry_attempt_start',
]);

interface EventMapperInput {
  assistantSessionId: string;
  piSessionId: string;
  sourceInstanceId: string;
  now?: () => string;
  initialSequence?: number;
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

/** Pi 原始对象只在映射器内部读取，公共未知事件只保留类型和顺序。 */
export class PiCoordinatorEventMapper {
  private sequence: number;
  private lastRunStatus: CoordinatorRunStatus = 'completed';
  private lastUsage: CoordinatorUsage | undefined;
  private lastRunResult: CoordinatorRunResult | undefined;
  private lastSummarizationRetryAttempt = 0;
  private readonly now: () => string;

  constructor(private readonly input: EventMapperInput) {
    this.sequence = input.initialSequence ?? 0;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  getLastRunResult(): CoordinatorRunResult | undefined {
    return this.lastRunResult;
  }

  resetRunResult(): void {
    this.lastRunStatus = 'completed';
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
          messageId: messageId(event.message),
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
          messageId: messageId(event.message),
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
          messageId: messageId(message),
          role: messageRole(message),
          ...(stopReason === undefined ? {} : { stopReason }),
          ...(usage === undefined ? {} : { usage }),
        };
      }
      case 'tool_execution_start':
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          argumentKeys: argumentKeys(event.args),
        };
      case 'tool_execution_update':
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.updated',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
      case 'tool_execution_end':
        return {
          ...this.nextBase(),
          type: 'coordinator.tool.ended',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        };
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

    if (stopReason === 'aborted') {
      this.lastRunStatus = 'cancelled';
    } else if (stopReason === 'error') {
      this.lastRunStatus = 'failed';
    } else if (stopReason) {
      this.lastRunStatus = 'completed';
    }
  }

  private captureRetryOutcome(success: boolean, finalError: string | undefined): void {
    const outcome = this.retryOutcome(success, finalError);
    if (outcome === 'cancelled') {
      this.lastRunStatus = 'cancelled';
    } else if (outcome === 'failed') {
      this.lastRunStatus = 'failed';
    } else if (outcome === 'succeeded') {
      this.lastRunStatus = 'completed';
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
