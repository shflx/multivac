import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantPublicEvent, ToolAuthorizationRequest, ToolAuthorizationStatus } from '@multivac/contracts';
import { AssistantApiError } from '../src/data/assistant-api.js';
import {
  applyAuthorizationEvent,
  approvalLabel,
  approvedDetail,
  authorizationDecisionError,
  grantDirectoryLabel,
  mergeAuthorizations,
  pendingAuthorizations,
  rememberedApproval,
  rememberedScopeText,
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
    approval: status === 'approved' ? { scope: 'once', source: 'user', grantId: null } : null,
    remember: { directory: '/work', projectId: null },
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

test('批准范围的文案：卡片写明记住的范围，工具行区分用户批准的范围与按已记住的授权放行', () => {
  assert.equal(grantDirectoryLabel('/work/reports'), '/work/reports/');
  assert.equal(grantDirectoryLabel('/work/reports/'), '/work/reports/');
  assert.equal(rememberedScopeText('read', '/work/reports'), '读取 /work/reports/ 中的文件');
  assert.equal(rememberedScopeText('edit', '/work/reports'), '修改或写入 /work/reports/ 中的文件');
  assert.equal(rememberedScopeText('write', '/work/reports'), '修改或写入 /work/reports/ 中的文件');

  const approved = (scope: 'once' | 'session' | 'project', source: 'user' | 'grant' = 'user') =>
    request('approved', { approval: { scope, source, grantId: scope === 'once' ? null : 'grant-1' } });
  assert.equal(approvedDetail(approved('once')), '已批准（仅这一次）');
  assert.equal(approvedDetail(approved('session')),
    '已批准（本会话内）：之后本会话修改或写入 /work/ 中的文件不再确认，可在“设置 · 授权记录”中撤销');
  assert.match(approvedDetail(approved('project')), /^已批准（本项目内始终）：之后项目中的会话修改或写入/u);

  assert.equal(approvalLabel({ scope: 'once', source: 'user', grantId: null }), '已批准（仅这一次）');
  assert.equal(approvalLabel({ scope: 'project', source: 'user', grantId: 'grant-1' }), '已批准（本项目内）');
  assert.equal(approvalLabel({ scope: 'session', source: 'grant', grantId: 'grant-1' }), '按已记住的授权放行（本会话内）');

  // 按已记住的授权放行的记录不出卡片；用户批准与待授权的照常出卡片。
  assert.equal(rememberedApproval(approved('session', 'grant')), true);
  assert.equal(rememberedApproval(approved('session')), false);
  assert.equal(rememberedApproval(request('pending')), false);
});
