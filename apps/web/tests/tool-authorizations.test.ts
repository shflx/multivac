import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent, ToolAuthorizationRequest, ToolAuthorizationStatus } from '@multivac/contracts';
import { AssistantApiError } from '../src/data/assistant-api.js';
import {
  applyAuthorizationEvent,
  authorizationDecisionError,
  mergeAuthorizations,
  pendingAuthorizations,
  upsertAuthorization,
} from '../src/features/assistant/tool-authorizations.js';

const AT = '2026-09-28T08:00:00.000Z';
let cursor = 10;

function event<T extends AssistantPublicEvent['type']>(
  type: T,
  data: Extract<AssistantPublicEvent, { type: T }>['data'],
  occurredAt = AT,
): AssistantPublicEvent {
  cursor += 1;
  return {
    cursor: String(cursor), eventId: `event-${cursor}`, assistantSessionId: 'global-coordinator',
    commandId: 'command-1', occurredAt, type, data,
  } as AssistantPublicEvent;
}

function request(status: ToolAuthorizationStatus, extra: Partial<ToolAuthorizationRequest> = {}): ToolAuthorizationRequest {
  return {
    requestId: 'request-1', sessionId: 'global-coordinator', commandId: 'command-1', toolName: 'write',
    toolCallId: 'tool-1', requestedPath: '../outside.txt', targetPath: '/work/outside.txt',
    workingDirectory: { kind: 'multivac', path: '/work/multivac' }, status, createdAt: AT,
    expiresAt: '2026-09-28T08:30:00.000Z', decidedAt: status === 'pending' ? null : '2026-09-28T08:00:05.000Z',
    ...extra,
  };
}

test('授权请求合并时终态优先：迟到的待授权快照不会让已决定的卡片回退', () => {
  const pending = request('pending');
  const denied = request('denied');
  assert.deepEqual(upsertAuthorization([denied], pending), [denied]);
  assert.deepEqual(upsertAuthorization([pending], denied), [denied]);

  const later = request('pending', { requestId: 'request-2', toolCallId: 'tool-2', createdAt: '2026-09-28T08:01:00.000Z' });
  // 查询结果与事件交错到达：按请求 id 合并，按创建时间排序。
  const merged = mergeAuthorizations([later], [pending, denied]);
  assert.deepEqual(merged.map((item) => [item.requestId, item.status]), [['request-1', 'denied'], ['request-2', 'pending']]);
  assert.deepEqual(pendingAuthorizations(merged).map((item) => item.requestId), ['request-2']);

  const applied = applyAuthorizationEvent(merged, event('assistant.authorization.resolved', {
    request: { ...later, status: 'approved', decidedAt: AT },
  }));
  assert.deepEqual(pendingAuthorizations(applied), []);
  // 其他事件不影响授权记录。
  assert.deepEqual(applyAuthorizationEvent(applied, event('assistant.run.processing', {})), applied);
});

test('决定失败的说明：冲突与已离开待授权沿用服务端说明并刷新卡片，其他失败保留重试', () => {
  assert.deepEqual(
    authorizationDecisionError(new AssistantApiError('AUTHORIZATION_CONFLICT', '授权请求已拒绝，不能改为另一个决定。', 409)),
    { message: '授权请求已拒绝，不能改为另一个决定。', refresh: true },
  );
  assert.deepEqual(
    authorizationDecisionError(new AssistantApiError('AUTHORIZATION_NOT_PENDING', '授权请求已过期（等待超时，本轮已结束），批准不会执行任何操作。', 409)).refresh,
    true,
  );
  assert.equal(authorizationDecisionError(new AssistantApiError('NOT_FOUND', '授权请求不存在。', 404)).refresh, true);
  assert.deepEqual(
    authorizationDecisionError(new AssistantApiError('INTERNAL_ERROR', '服务暂不可用。', 500)),
    { message: '决定没有提交：服务暂不可用。', refresh: false },
  );
  assert.equal(authorizationDecisionError(new TypeError('fetch failed')).refresh, false);
});
