import type { AssistantPublicEvent, CoordinatorAdapterEvent } from '@multivac/contracts';
import type {
  AssistantEventRepository,
  AssistantProjectionReceiptUpdate,
} from '../modules/sessions/assistant-turn.js';
import type { CoordinatorAdapter } from '../runtime/executors/coordinator-adapter.js';
import { AssistantEventStream } from './assistant-event-stream.js';

export interface AssistantEventProjectorOptions {
  adapter: CoordinatorAdapter;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  assistantSessionId: string;
  currentPromptCommandId: () => string | null;
}

type Projection = Pick<AssistantPublicEvent, 'type' | 'data'>;

function safeProjection(event: CoordinatorAdapterEvent): Projection | null {
  switch (event.type) {
    case 'coordinator.message.delta':
    case 'coordinator.unknown':
      return null;
    case 'coordinator.run.started':
      return { type: 'assistant.run.processing', data: {} };
    case 'coordinator.run.ended':
      return null;
    case 'coordinator.turn.started':
      return { type: 'assistant.turn.started', data: { turnRef: event.eventId } };
    case 'coordinator.turn.ended':
      return { type: 'assistant.turn.ended', data: {} };
    case 'coordinator.message.started':
    case 'coordinator.message.ended':
      return {
        type: 'assistant.message.changed',
        data: { messageId: event.messageId, role: event.role },
      };
    case 'coordinator.tool.started':
      return {
        type: 'assistant.tool.started',
        data: { toolCallId: event.toolCallId, toolName: event.toolName },
      };
    case 'coordinator.tool.updated':
      return {
        type: 'assistant.tool.updated',
        data: { toolCallId: event.toolCallId, toolName: event.toolName },
      };
    case 'coordinator.tool.ended':
      return {
        type: 'assistant.tool.ended',
        data: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError },
      };
    case 'coordinator.queue.updated':
      return {
        type: 'assistant.queue.updated',
        data: { steeringCount: event.steeringCount, followUpCount: event.followUpCount },
      };
    case 'coordinator.retry.started':
      return {
        type: 'assistant.retry.started',
        data: { scope: event.scope, attempt: event.attempt, maxAttempts: event.maxAttempts },
      };
    case 'coordinator.retry.ended':
      return {
        type: 'assistant.retry.ended',
        data: { scope: event.scope, attempt: event.attempt, outcome: event.outcome },
      };
    case 'coordinator.compaction.started':
      return { type: 'assistant.compaction.started', data: { reason: event.reason } };
    case 'coordinator.compaction.ended':
      return {
        type: 'assistant.compaction.ended',
        data: {
          reason: event.reason,
          status: event.status,
          willRetry: event.willRetry,
          ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        },
      };
    case 'coordinator.run.completed':
      return { type: 'assistant.run.succeeded', data: {} };
    case 'coordinator.run.failed':
      return { type: 'assistant.run.failed', data: {} };
    case 'coordinator.run.cancelled':
      return { type: 'assistant.run.cancelled', data: {} };
  }
}

/** 将 DEV-154 runtime 事件逐字段白名单投影，禁止 delta/thinking/tool payload 透传。 */
export class AssistantEventProjector {
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: AssistantEventProjectorOptions) {}

  start(): void {
    if (this.unsubscribe) return;
    const subscription = this.options.adapter.subscribe(
      this.options.assistantSessionId,
      (event) => this.project(event),
    );
    if (!subscription.ok) throw new Error(subscription.error.message);
    this.unsubscribe = subscription.value;
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  project(event: CoordinatorAdapterEvent): AssistantPublicEvent | null {
    const projection = safeProjection(event);
    if (!projection) return null;
    const commandId = this.options.currentPromptCommandId();
    const receiptUpdate: AssistantProjectionReceiptUpdate | undefined = commandId &&
      event.type === 'coordinator.run.started'
      ? { type: 'running', commandId, piTurnRef: event.eventId }
      : commandId && (
          event.type === 'coordinator.run.completed' ||
          event.type === 'coordinator.run.failed' ||
          event.type === 'coordinator.run.cancelled'
        )
        ? {
            type: 'terminal',
            commandId,
            terminalOutcome: event.type === 'coordinator.run.completed'
              ? 'succeeded'
              : event.type === 'coordinator.run.failed'
                ? 'failed'
                : 'cancelled',
          }
        : undefined;
    const mutation = this.options.eventRepository.project({
      sourceKey: `pi:${event.piSessionId}:${event.sourceInstanceId}:${event.sequence}:${projection.type}`,
      assistantSessionId: event.assistantSessionId,
      commandId,
      type: projection.type,
      data: projection.data,
      occurredAt: event.occurredAt,
    }, receiptUpdate);
    this.options.eventStream.publish(mutation.event);
    return mutation.event;
  }
}
