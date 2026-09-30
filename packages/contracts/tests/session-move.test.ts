import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  MoveSessionToProjectSchema,
  SESSION_MOVE_ENTRY_LIST_LIMIT,
  SessionMovePreviewRequestSchema,
  SessionMovePreviewSchema,
  SessionMoveResultSchema,
} from '../src/index.js';

const temp = { kind: 'session-temp', path: '/Users/me/Multivac/sessions/2026-09-28-调研-abcd1234' };
const managed = { kind: 'project-managed', path: '/Users/me/Multivac/projects/技术研究' };

test('归入项目的请求：必须给出项目与是否移入文件，不接受其他字段', () => {
  assert.equal(Check(MoveSessionToProjectSchema, { projectId: 'p-1', moveFiles: true }), true);
  assert.equal(Check(MoveSessionToProjectSchema, { projectId: 'p-1' }), false);
  assert.equal(Check(MoveSessionToProjectSchema, { projectId: '', moveFiles: false }), false);
  assert.equal(Check(MoveSessionToProjectSchema, { projectId: 'p-1', moveFiles: false, workingDirectory: managed }), false);
  assert.equal(Check(SessionMovePreviewRequestSchema, { projectId: 'p-1' }), true);
  assert.equal(Check(SessionMovePreviewRequestSchema, { projectId: 'p-1', moveFiles: true }), false);
});

test('归入前的核对与归入结果：临时目录的条目与重名列表有上限，不是临时目录时没有文件', () => {
  const files = { total: 2, names: ['README.md', 'notes'], conflictTotal: 1, conflicts: ['README.md'] };
  assert.equal(Check(SessionMovePreviewSchema, { sessionId: 's-1', from: temp, to: managed, running: false, files, tempRetentionDays: 30 }), true);
  assert.equal(Check(SessionMovePreviewSchema, { sessionId: 's-1', from: managed, to: managed, running: true, files: null, tempRetentionDays: null }), true);
  const tooMany = Array.from({ length: SESSION_MOVE_ENTRY_LIST_LIMIT + 1 }, (_, index) => `f-${index}`);
  assert.equal(Check(SessionMovePreviewSchema, {
    sessionId: 's-1', from: temp, to: managed, running: false, files: { ...files, names: tooMany }, tempRetentionDays: 30,
  }), false);

  const session = {
    sessionId: 's-1', title: '调研', kind: 'work', workspaceId: 'p-1', createdAt: '2026-09-28T08:00:00.000Z',
    archivedAt: null, parentSessionId: null, originText: null, workingDirectory: managed,
  };
  assert.equal(Check(SessionMoveResultSchema, {
    session, files: { moved: 1, skippedTotal: 1, skipped: ['README.md'] }, sourceRemoved: false, tempRetentionDays: 30,
  }), true);
  assert.equal(Check(SessionMoveResultSchema, { session, files: null, sourceRemoved: true, tempRetentionDays: 7 }), true);
  assert.equal(Check(SessionMoveResultSchema, { session, files: { moved: -1, skippedTotal: 0, skipped: [] }, sourceRemoved: true, tempRetentionDays: 30 }), false);
  // 保留时长只接受 7 / 30 / 90 天或从不（null）。
  assert.equal(Check(SessionMoveResultSchema, { session, files: null, sourceRemoved: true, tempRetentionDays: 14 }), false);
});

test('原临时目录正被项目或其他会话使用：核对与结果可以写明（sourceInUse），旧版不带这个字段同样有效', () => {
  const files = { total: 1, names: ['notes.md'], conflictTotal: 0, conflicts: [] };
  assert.equal(Check(SessionMovePreviewSchema, {
    sessionId: 's-1', from: temp, to: managed, running: false, files, tempRetentionDays: 30, sourceInUse: true,
  }), true);
  assert.equal(Check(SessionMovePreviewSchema, {
    sessionId: 's-1', from: temp, to: managed, running: false, files, tempRetentionDays: 30, sourceInUse: 'yes',
  }), false);
  const session = {
    sessionId: 's-1', title: '调研', kind: 'work', workspaceId: 'p-1', createdAt: '2026-09-28T08:00:00.000Z',
    archivedAt: null, parentSessionId: null, originText: null, workingDirectory: managed,
  };
  assert.equal(Check(SessionMoveResultSchema, { session, files: null, sourceRemoved: false, tempRetentionDays: 30, sourceInUse: true }), true);
  assert.equal(Check(SessionMoveResultSchema, { session, files: null, sourceRemoved: false, tempRetentionDays: 30 }), true);
});
