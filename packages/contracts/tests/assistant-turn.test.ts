import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantCommandReceiptSchema,
  AssistantCommandReconciliationResponseSchema,
  AssistantPublicEventSchema,
  CancelAssistantTurnCommandSchema,
  SendAssistantMessageCommandSchema,
} from '../src/index.js';

test('助手发送和取消命令只接受受控 ID、空 contextRefs 与显式 behavior', () => {
  const base = {
    commandId: 'command:123e4567-e89b-12d3-a456-426614174000',
    assistantSessionId: 'global-coordinator',
    text: '  保留原始换行\n继续处理  ',
    contextRefs: [],
  };
  assert.equal(Check(SendAssistantMessageCommandSchema, base), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...base, streamingBehavior: 'steer' }), true);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...base, streamingBehavior: 'auto' }), false);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...base, contextRefs: ['browser'] }), false);
  assert.equal(Check(SendAssistantMessageCommandSchema, { ...base, commandId: 'bad id' }), false);
  assert.equal(Check(CancelAssistantTurnCommandSchema, {
    commandId: 'cancel-1', assistantSessionId: 'global-coordinator',
  }), true);
});

test('命令对账五态和安全公共事件不包含消息正文或工具 payload', () => {
  const receipt = {
    commandId: 'command-1',
    assistantSessionId: 'global-coordinator',
    kind: 'send',
    status: 'terminal',
    terminalOutcome: 'succeeded',
    error: null,
    piSessionId: 'pi-1',
    piEntryId: 'entry-1',
    piTurnRef: 'pi-event-2',
    createdAt: '2026-09-14T08:00:00.000Z',
    updatedAt: '2026-09-14T08:00:01.000Z',
  };
  assert.equal(Check(AssistantCommandReceiptSchema, receipt), true);
  assert.equal(Check(AssistantCommandReconciliationResponseSchema, {
    commandId: 'missing', status: 'unknown', receipt: null,
  }), true);

  const event = {
    cursor: '12',
    eventId: 'assistant-event:12',
    assistantSessionId: 'global-coordinator',
    commandId: 'command-1',
    occurredAt: '2026-09-14T08:00:00.000Z',
    type: 'assistant.tool.started',
    data: { toolCallId: 'tool-1', toolName: 'propose_task' },
  };
  assert.equal(Check(AssistantPublicEventSchema, event), true);
  assert.equal(Check(AssistantPublicEventSchema, {
    ...event,
    data: { ...event.data, arguments: { title: '不得公开' } },
  }), false);
  assert.equal(JSON.stringify(event).includes('不得公开'), false);
});
