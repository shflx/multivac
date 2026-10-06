import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxDecisionConsequence, markInboxRequestSeen, nextInboxRequest, pendingInboxRequests, toolAuthorizationAction } from './inbox-state.js';
import { canSubmitDecision, grantFromDecision, grantsOf, revokeGrant } from './ui-state.js';
import { taskAfterDecision } from './task-panel-state.js';

const requests = [
  { id: 'nonblocking-old', state: 'new', blocksWork: false, createdAt: '2026-10-01T08:00:00Z', age: '刚刚' },
  { id: 'blocking-new', state: 'new', blocksWork: true, createdAt: '2026-10-01T11:00:00Z', impact: '可暂缓' },
  { id: 'done', state: 'done', blocksWork: true, createdAt: '2026-10-01T07:00:00Z' },
  { id: 'blocking-old', state: 'seen', blocksWork: true, createdAt: '2026-10-01T09:00:00Z', impact: '示例文案', age: '1 秒前' },
  { id: 'nonblocking-new', state: 'seen', blocksWork: false, createdAt: '2026-10-01T10:00:00Z' },
];

test('阻塞优先、同组等待越久越靠前，排序不解析展示文案或改动原数组', () => {
  assert.deepEqual(pendingInboxRequests(requests).map(({ id }) => id), ['blocking-old', 'blocking-new', 'nonblocking-old', 'nonblocking-new']);
  assert.equal(requests[0].id, 'nonblocking-old');
  assert.equal(pendingInboxRequests(requests).length, 4);
  assert.deepEqual(pendingInboxRequests([{ id: 'missing', state: 'new' }, { id: 'known', state: 'new', createdAt: '2026-10-01T10:00:00Z' }]).map(({ id }) => id), ['known', 'missing']);
});

test('隐藏抽屉、列表预选不算已查看；只标记实际可见的未查看详情', () => {
  assert.equal(markInboxRequestSeen(requests, 'blocking-new'), requests);
  assert.equal(markInboxRequestSeen(requests, 'blocking-new', { visible: false, detailOpen: true }), requests);
  assert.equal(markInboxRequestSeen(requests, 'blocking-new', { visible: true, detailOpen: false }), requests);
  const seen = markInboxRequestSeen(requests, 'blocking-new', { visible: true, detailOpen: true });
  assert.equal(seen.find(({ id }) => id === 'blocking-new').state, 'seen');
  assert.equal(seen.find(({ id }) => id === 'nonblocking-old').state, 'new');
  assert.equal(pendingInboxRequests(seen).length, 4);
  assert.equal(markInboxRequestSeen(seen, 'blocking-new', { visible: true, detailOpen: true }), seen);
  assert.equal(markInboxRequestSeen(requests, 'done', { visible: true, detailOpen: true }), requests);
});

test('下一项始终来自排序后的待处理队列，处理后仍保留当前结果', () => {
  assert.equal(nextInboxRequest(requests, 'blocking-old').id, 'blocking-new');
  const processed = requests.map((request) => request.id === 'blocking-old' ? { ...request, state: 'done' } : request);
  assert.equal(processed.find(({ id }) => id === 'blocking-old').state, 'done');
  assert.equal(nextInboxRequest(processed, 'blocking-old').id, 'blocking-new');
  assert.equal(nextInboxRequest(requests.map((request) => ({ ...request, state: 'done' })), 'blocking-old'), null);
  assert.equal(nextInboxRequest([{ id: 'only', state: 'new' }], 'only'), null);
});

test('授权范围默认一次；无项目或失效范围不扩大授权，并保留记录及撤销映射', () => {
  assert.equal(toolAuthorizationAction(), 'once');
  assert.equal(toolAuthorizationAction('unknown', 'p'), 'once');
  assert.equal(toolAuthorizationAction('project', null), 'once');
  for (const scope of ['once', 'session', 'project']) {
    const action = toolAuthorizationAction(scope, 'p');
    assert.equal(action, scope);
    assert.equal(canSubmitDecision('工具授权', action), true);
    const grant = grantFromDecision({ action, subject: 'GitHub · push_branch', sessionId: 's', projectId: 'p', id: scope });
    if (scope === 'once') assert.equal(grant, null);
    else {
      assert.equal(grant.scope, scope);
      assert.deepEqual(grantsOf([grant], scope === 'project' ? { projectId: 'p' } : { sessionId: 's' }), [grant]);
      assert.deepEqual(revokeGrant([grant], grant.id), []);
    }
  }
  assert.equal(grantFromDecision({ action: 'deny', projectId: 'p' }), null);
});

test('修改意见必须有效，提交后任务暂停待修改；验收通过后完成', () => {
  assert.equal(canSubmitDecision('验收', 'revise', ' \n '), false);
  const request = { type: '验收' };
  assert.equal(taskAfterDecision(request, 'revise', '补充移动端状态').status, 'paused');
  assert.equal(taskAfterDecision(request, 'accept').status, 'done');
  assert.match(inboxDecisionConsequence(request, 'revise', '补充移动端状态'), /补充移动端状态/);
  assert.match(inboxDecisionConsequence(request, 'accept', ''), /来源任务已完成/);
});

test('结果确认描述真实选择后果，不把拒绝发布等同于删除成果', () => {
  assert.match(inboxDecisionConsequence({ type: '外发授权' }, 'deny', ''), /成果保留/);
  assert.match(inboxDecisionConsequence({ type: '恢复确认' }, 'stop', ''), /保持停止/);
  assert.match(inboxDecisionConsequence({ type: '工具授权', capability: 'push_branch' }, 'project', '', { project: { name: '开发' } }), /开发.*push_branch.*撤销/);
});
