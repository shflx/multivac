import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolAuthorizationGrant, ToolAuthorizationRequest } from '@multivac/contracts';
import {
  AUTHORIZATION_PATH_MAX_LENGTH,
  grantMetaText,
  grantSubject,
  recordTime,
  requestOutcomeText,
  requestSubject,
} from '../src/features/authorizations/authorization-view.js';

const grant: ToolAuthorizationGrant = {
  grantId: 'grant-1', scope: 'session', sessionId: 'work-1', projectId: null, access: 'write',
  directory: '/data/reports', sourceRequestId: 'request-1', createdAt: '2026-09-28T08:00:00.000Z',
  lastUsedAt: null, useCount: 0, revokedAt: null,
};

test('记住的授权一行：主题是类别与放行目录，说明是“目录 · 范围 · 记住于 …”，另附最近使用', () => {
  assert.deepEqual(grantSubject(grant), {
    text: '修改或写入 /data/reports/',
    full: '修改或写入 /data/reports/',
    title: '修改或写入 /data/reports/ 中的文件（含子目录）',
  });
  assert.equal(grantSubject({ ...grant, access: 'read' }).text, '读取 /data/reports/');
  assert.match(grantMetaText(grant), /^目录 · 本会话内允许 · 记住于 9\/28 \d{2}:00 · 还没有用过$/u);
  assert.match(
    grantMetaText({ ...grant, scope: 'project', sessionId: null, projectId: 'p', lastUsedAt: '2026-09-28T08:30:00.000Z', useCount: 3 }),
    /^目录 · 本项目内始终允许 · 记住于 9\/28 \d{2}:00 · 最近使用 9\/28 \d{2}:30（共 3 次）$/u,
  );
  assert.match(recordTime('2026-09-28T08:05:00.000Z'), /^9\/28 \d{2}:05$/u);
  assert.equal(recordTime('不是时间'), '不是时间');
});

test('长路径中间截断，保留开头与结尾的目录名；完整路径在悬停提示里', () => {
  const directory = '/private/var/folders/xy/abcdefghijklmnop/T/multivac-e2e/sessions/multivac-outside';
  const subject = grantSubject({ ...grant, directory });
  const shown = subject.text.slice('修改或写入 '.length);
  assert.equal(Array.from(shown).length, AUTHORIZATION_PATH_MAX_LENGTH);
  assert.ok(shown.startsWith('/private/var/'));
  assert.ok(shown.endsWith('multivac-outside/'));
  assert.ok(shown.includes('…'));
  assert.equal(subject.full, `修改或写入 ${directory}/`);
  assert.equal(subject.title, `修改或写入 ${directory}/ 中的文件（含子目录）`);

  const request = { toolName: 'write', targetPath: `${directory}/write-probe-1.txt` } as ToolAuthorizationRequest;
  assert.ok(requestSubject(request).text.endsWith('write-probe-1.txt'));
  assert.equal(requestSubject(request).title, `写入 ${directory}/write-probe-1.txt`);
});

test('最近的授权请求写明操作与结果：批准依据（仅这一次 / 本会话内 / 本项目内 / 按已记住的授权放行）或未获批准的原因', () => {
  const request = {
    toolName: 'edit', targetPath: '/data/reports/q3.md', status: 'approved',
    approval: { scope: 'project', source: 'grant', grantId: 'grant-1' },
  } as ToolAuthorizationRequest;
  assert.deepEqual(requestSubject(request), {
    text: '修改 /data/reports/q3.md', full: '修改 /data/reports/q3.md', title: '修改 /data/reports/q3.md',
  });
  assert.equal(requestOutcomeText(request), '按已记住的授权放行（本项目内）');
  assert.equal(requestOutcomeText({ ...request, approval: { scope: 'once', source: 'user', grantId: null } }), '已批准（仅这一次）');
  assert.equal(requestOutcomeText({ ...request, approval: { scope: 'session', source: 'user', grantId: 'g' } }), '已批准（本会话内）');
  assert.equal(requestOutcomeText({ ...request, approval: { scope: 'project', source: 'user', grantId: 'g' } }), '已批准（本项目内）');
  assert.equal(requestOutcomeText({ ...request, status: 'pending', approval: null }), '待授权');
  assert.equal(requestOutcomeText({ ...request, status: 'denied', approval: null }), '已拒绝');
  assert.equal(requestOutcomeText({ ...request, status: 'expired', approval: null }), '已过期');
  assert.equal(requestOutcomeText({ ...request, status: 'invalidated', approval: null }), '已失效');
  assert.equal(requestOutcomeText({ ...request, status: 'cancelled', approval: null }), '已取消');
});
