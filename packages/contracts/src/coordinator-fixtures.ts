import type { CoordinatorAdapterEvent } from './coordinator-runtime.js';

const SESSION_ID = 'assistant-fixture';
const PI_SESSION_ID = 'pi-fixture';
const SOURCE_INSTANCE_ID = 'fixture-instance';
const OCCURRED_AT = '2026-09-14T08:00:00.000Z';

function eventBase(sequence: number) {
  const cursor = `${PI_SESSION_ID}:${SOURCE_INSTANCE_ID}:${sequence}`;

  return {
    eventId: cursor,
    cursor,
    sequence,
    sourceInstanceId: SOURCE_INSTANCE_ID,
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
      channel: 'thinking',
      delta: '正在梳理当前请求需要核对的范围和执行步骤。',
    },
    {
      ...eventBase(4),
      type: 'coordinator.message.delta',
      messageId: 'assistant:1',
      channel: 'text',
      delta: '已整理当前工作。',
    },
    {
      ...eventBase(5),
      type: 'coordinator.tool.started',
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      argumentKeys: ['title'],
      inputText: 'title: 整理 MVP 范围',
      inputTruncated: false,
    },
    {
      ...eventBase(6),
      type: 'coordinator.tool.ended',
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      isError: false,
    },
    {
      ...eventBase(7),
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
  compactionFailureThenSuccess: [
    { ...eventBase(1), type: 'coordinator.run.started' },
    { ...eventBase(2), type: 'coordinator.compaction.started', reason: 'threshold' },
    {
      ...eventBase(3),
      type: 'coordinator.compaction.ended',
      reason: 'threshold',
      status: 'failed',
      willRetry: false,
      errorCode: 'COMPACTION_FAILED',
    },
    { ...eventBase(4), type: 'coordinator.run.completed' },
  ],
  compactionFailureThenFailure: [
    { ...eventBase(1), type: 'coordinator.run.started' },
    { ...eventBase(2), type: 'coordinator.compaction.started', reason: 'threshold' },
    {
      ...eventBase(3),
      type: 'coordinator.compaction.ended',
      reason: 'threshold',
      status: 'failed',
      willRetry: false,
      errorCode: 'COMPACTION_FAILED',
    },
    { ...eventBase(4), type: 'coordinator.run.failed' },
  ],
  toolFailureThenSuccess: [
    { ...eventBase(1), type: 'coordinator.run.started' },
    {
      ...eventBase(2),
      type: 'coordinator.message.delta',
      messageId: 'assistant:tool-run',
      channel: 'thinking',
      delta: '先检查失败的工具调用，再继续核对相关约束。',
    },
    {
      ...eventBase(3),
      type: 'coordinator.tool.started',
      toolCallId: 'tool-retry',
      toolName: 'propose_task',
      argumentKeys: ['title'],
      inputText: 'title: 整理 MVP 范围',
      inputTruncated: false,
    },
    {
      ...eventBase(4),
      type: 'coordinator.tool.ended',
      toolCallId: 'tool-retry',
      toolName: 'propose_task',
      isError: true,
    },
    {
      ...eventBase(5),
      type: 'coordinator.message.delta',
      messageId: 'assistant:tool-run:follow-up',
      channel: 'thinking',
      delta: '失败步骤已经记录，继续读取项目约束确认后续处理。',
    },
    {
      ...eventBase(6),
      type: 'coordinator.tool.started',
      toolCallId: 'tool-check',
      toolName: 'read',
      argumentKeys: ['path'],
      inputText: 'path: PROJECT_CONSTRAINTS.md',
      inputTruncated: false,
    },
    {
      ...eventBase(7),
      type: 'coordinator.tool.ended',
      toolCallId: 'tool-check',
      toolName: 'read',
      isError: false,
    },
    { ...eventBase(8), type: 'coordinator.run.completed' },
  ],
  toolFailureThenFailure: [
    { ...eventBase(1), type: 'coordinator.run.started' },
    {
      ...eventBase(2),
      type: 'coordinator.message.delta',
      messageId: 'assistant:tool-failed-run',
      channel: 'thinking',
      delta: '正在检查工具失败原因。',
    },
    {
      ...eventBase(3),
      type: 'coordinator.tool.started',
      toolCallId: 'tool-failed',
      toolName: 'propose_task',
      argumentKeys: ['title'],
      inputText: 'title: 整理 MVP 范围',
      inputTruncated: false,
    },
    {
      ...eventBase(4),
      type: 'coordinator.tool.ended',
      toolCallId: 'tool-failed',
      toolName: 'propose_task',
      isError: true,
    },
    { ...eventBase(5), type: 'coordinator.run.failed' },
  ],
  failure: [{ ...eventBase(1), type: 'coordinator.run.failed' }],
  cancelled: [{ ...eventBase(1), type: 'coordinator.run.cancelled' }],
} as const satisfies Record<string, readonly CoordinatorAdapterEvent[]>;
