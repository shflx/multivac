import type { CoordinatorAdapterEvent } from './coordinator-runtime.js';

const SESSION_ID = 'assistant-fixture';
const PI_SESSION_ID = 'pi-fixture';
const OCCURRED_AT = '2026-09-14T08:00:00.000Z';

function eventBase(sequence: number) {
  const cursor = `${PI_SESSION_ID}:${sequence}`;

  return {
    eventId: cursor,
    cursor,
    sequence,
    assistantSessionId: SESSION_ID,
    piSessionId: PI_SESSION_ID,
    occurredAt: OCCURRED_AT,
  };
}

export const COORDINATOR_EVENT_FIXTURES = {
  success: [
    { ...eventBase(1), type: 'coordinator.run.started' },
    { ...eventBase(2), type: 'coordinator.message.started', messageId: 'assistant:1', role: 'assistant' },
    {
      ...eventBase(3),
      type: 'coordinator.message.delta',
      messageId: 'assistant:1',
      channel: 'text',
      delta: '已整理当前工作。',
    },
    {
      ...eventBase(4),
      type: 'coordinator.tool.started',
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      argumentKeys: ['title'],
    },
    {
      ...eventBase(5),
      type: 'coordinator.tool.ended',
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      isError: false,
    },
    {
      ...eventBase(6),
      type: 'coordinator.run.completed',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        totalTokens: 170,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
      },
    },
  ],
  retryAndCompaction: [
    {
      ...eventBase(1),
      type: 'coordinator.retry.started',
      scope: 'run',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
    },
    {
      ...eventBase(2),
      type: 'coordinator.retry.ended',
      scope: 'run',
      outcome: 'succeeded',
      attempt: 1,
    },
    { ...eventBase(3), type: 'coordinator.compaction.started', reason: 'threshold' },
    {
      ...eventBase(4),
      type: 'coordinator.compaction.ended',
      reason: 'threshold',
      status: 'succeeded',
      willRetry: false,
    },
  ],
  failure: [{ ...eventBase(1), type: 'coordinator.run.failed' }],
  cancelled: [{ ...eventBase(1), type: 'coordinator.run.cancelled' }],
} as const satisfies Record<string, readonly CoordinatorAdapterEvent[]>;
