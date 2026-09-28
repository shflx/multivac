import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantPublicEventSchema,
  DecideToolAuthorizationSchema,
  ToolAuthorizationListResponseSchema,
  ToolAuthorizationRequestSchema,
} from '../src/index.js';

const request = {
  requestId: '6f1d0a4e-0b8e-4d0f-9d3c-1b2a3c4d5e6f',
  sessionId: 'work-1',
  commandId: 'command-1',
  toolName: 'write',
  toolCallId: 'call-1-0',
  requestedPath: '../outside.txt',
  targetPath: '/Users/me/Multivac/sessions/outside.txt',
  workingDirectory: { kind: 'session-temp', path: '/Users/me/Multivac/sessions/2026-09-28-会话-work1' },
  status: 'pending',
  createdAt: '2026-09-28T08:00:00.000Z',
  expiresAt: '2026-09-28T08:30:00.000Z',
  decidedAt: null,
};

test('授权请求只接受文件工具、六种状态与显式字段', () => {
  assert.equal(Check(ToolAuthorizationRequestSchema, request), true);
  for (const status of ['approved', 'denied', 'cancelled', 'expired', 'invalidated']) {
    assert.equal(Check(ToolAuthorizationRequestSchema, { ...request, status, decidedAt: '2026-09-28T08:01:00.000Z' }), true);
  }
  assert.equal(Check(ToolAuthorizationRequestSchema, { ...request, status: 'remembered' }), false);
  assert.equal(Check(ToolAuthorizationRequestSchema, { ...request, toolName: 'bash' }), false);
  assert.equal(Check(ToolAuthorizationRequestSchema, { ...request, content: '文件内容' }), false);
  assert.equal(Check(ToolAuthorizationListResponseSchema, { sessionId: 'work-1', requests: [request] }), true);
});

test('决定只有“仅这一次”与“拒绝”', () => {
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'once' }), true);
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'deny' }), true);
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'session' }), false);
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'once', scope: 'project' }), false);
});

test('授权请求的创建与状态变化作为公共事件推送完整快照', () => {
  const base = {
    cursor: '42',
    eventId: 'assistant-event:42',
    assistantSessionId: 'work-1',
    commandId: 'command-1',
    occurredAt: '2026-09-28T08:00:00.000Z',
  };
  assert.equal(Check(AssistantPublicEventSchema, {
    ...base, type: 'assistant.authorization.requested', data: { request },
  }), true);
  assert.equal(Check(AssistantPublicEventSchema, {
    ...base, type: 'assistant.authorization.resolved',
    data: { request: { ...request, status: 'invalidated', decidedAt: '2026-09-28T09:00:00.000Z' } },
  }), true);
  assert.equal(Check(AssistantPublicEventSchema, {
    ...base, type: 'assistant.authorization.requested', data: { request, reason: '附加字段' },
  }), false);
});
