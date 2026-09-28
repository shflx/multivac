import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolAuthorizationGrant, ToolAuthorizationRequest, Workspace, WorkspaceSession } from '@multivac/contracts';
import {
  grantOwnerText,
  grantUsageText,
  recordTime,
  requestOperationText,
  requestOutcomeText,
  sessionLabel,
} from '../src/features/authorizations/authorization-records.js';

const sessions = [
  { sessionId: 'work-1', title: '调研', archivedAt: null },
  { sessionId: 'work-2', title: '旧会话', archivedAt: '2026-09-28T09:00:00.000Z' },
] as WorkspaceSession[];
const workspaces = [
  { workspaceId: 'project-1', name: '研究', project: { projectId: 'project-1', name: '研究' } },
  { workspaceId: 'default', name: '默认工作区', project: null },
] as Workspace[];

const grant: ToolAuthorizationGrant = {
  grantId: 'grant-1', scope: 'session', sessionId: 'work-1', projectId: null, access: 'write',
  directory: '/data/reports', sourceRequestId: 'request-1', createdAt: '2026-09-28T08:00:00.000Z',
  lastUsedAt: null, useCount: 0, revokedAt: null,
};

test('授权记录的归属写明范围与会话或项目；名称未读到、已归档与全局 Multivac 各有写法', () => {
  assert.equal(grantOwnerText(grant, sessions, workspaces), '本会话内允许 · 会话「调研」');
  assert.equal(grantOwnerText({ ...grant, sessionId: 'work-2' }, sessions, workspaces), '本会话内允许 · 会话「旧会话」（已归档）');
  assert.equal(grantOwnerText({ ...grant, sessionId: 'global-coordinator' }, sessions, workspaces), '本会话内允许 · 全局 Multivac');
  assert.equal(grantOwnerText(grant, null, null), '本会话内允许 · 会话');
  const projectGrant = { ...grant, scope: 'project' as const, sessionId: null, projectId: 'project-1' };
  assert.equal(grantOwnerText(projectGrant, sessions, workspaces), '本项目内始终允许 · 项目「研究」');
  assert.equal(grantOwnerText(projectGrant, sessions, null), '本项目内始终允许 · 项目');
  assert.equal(sessionLabel('missing', sessions), '会话');

  assert.equal(grantUsageText(grant), '还没有用过');
  assert.match(grantUsageText({ ...grant, lastUsedAt: '2026-09-28T08:30:00.000Z', useCount: 3 }), /^最近使用 9\/28 \d{2}:30（共 3 次）$/u);
  assert.match(recordTime('2026-09-28T08:05:00.000Z'), /^9\/28 \d{2}:05$/u);
  assert.equal(recordTime('不是时间'), '不是时间');
});

test('最近的授权请求写明操作、批准依据或未获批准的结果', () => {
  const request = {
    toolName: 'edit', targetPath: '/data/reports/q3.md', status: 'approved',
    approval: { scope: 'project', source: 'grant', grantId: 'grant-1' },
  } as ToolAuthorizationRequest;
  assert.equal(requestOperationText(request), '修改 /data/reports/q3.md');
  assert.equal(requestOutcomeText(request), '按已记住的授权放行（本项目内）');
  assert.equal(requestOutcomeText({ ...request, approval: { scope: 'once', source: 'user', grantId: null } }), '已批准（仅这一次）');
  assert.equal(requestOutcomeText({ ...request, status: 'pending', approval: null }), '待授权');
  assert.equal(requestOutcomeText({ ...request, status: 'denied', approval: null }), '已拒绝');
  assert.equal(requestOutcomeText({ ...request, status: 'invalidated', approval: null }), '已失效');
});
