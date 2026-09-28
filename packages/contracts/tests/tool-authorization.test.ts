import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  AssistantPublicEventSchema,
  DecideToolAuthorizationSchema,
  ToolAuthorizationGrantListResponseSchema,
  ToolAuthorizationGrantSchema,
  ToolAuthorizationHistoryResponseSchema,
  ToolAuthorizationListResponseSchema,
  ToolAuthorizationRequestSchema,
  toolAuthorizationAccess,
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
  approval: null,
  remember: { directory: '/Users/me/Multivac/sessions', projectId: null },
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

test('决定为“仅这一次 / 本会话内 / 本项目内 / 拒绝”，不接受客户端给出范围', () => {
  for (const decision of ['once', 'session', 'project', 'deny']) {
    assert.equal(Check(DecideToolAuthorizationSchema, { decision }), true);
  }
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'task' }), false);
  assert.equal(Check(DecideToolAuthorizationSchema, { decision: 'session', directory: '/' }), false);
});

test('批准写明范围与来源；记住的授权按会话或项目归属，读取与修改分开', () => {
  const approved = {
    ...request, status: 'approved', decidedAt: '2026-09-28T08:01:00.000Z',
    approval: { scope: 'session', source: 'grant', grantId: 'grant-1' }, remember: null,
  };
  assert.equal(Check(ToolAuthorizationRequestSchema, approved), true);
  assert.equal(Check(ToolAuthorizationRequestSchema, { ...approved, approval: { scope: 'always', source: 'user', grantId: null } }), false);
  assert.equal(Check(ToolAuthorizationRequestSchema, { ...request, remember: { directory: '/tmp' } }), false);

  const grant = {
    grantId: 'grant-1', scope: 'project', sessionId: null, projectId: 'project-1', access: 'read',
    directory: '/Users/me/docs', sourceRequestId: request.requestId, createdAt: '2026-09-28T08:01:00.000Z',
    lastUsedAt: null, useCount: 0, revokedAt: null,
  };
  assert.equal(Check(ToolAuthorizationGrantSchema, grant), true);
  assert.equal(Check(ToolAuthorizationGrantSchema, { ...grant, access: 'bash' }), false);
  assert.equal(Check(ToolAuthorizationGrantSchema, { ...grant, scope: 'once' }), false);
  assert.equal(Check(ToolAuthorizationGrantListResponseSchema, { grants: [grant] }), true);
  assert.equal(Check(ToolAuthorizationHistoryResponseSchema, { requests: [approved] }), true);

  assert.equal(toolAuthorizationAccess('read'), 'read');
  assert.equal(toolAuthorizationAccess('edit'), 'write');
  assert.equal(toolAuthorizationAccess('write'), 'write');
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
