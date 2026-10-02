import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { AssistantToolResultSchema } from '@multivac/contracts';
import { migrateLegacyManagementReceipt } from '../src/storage/legacy-management-receipt.js';

test('历史会话管理页回执迁移到归档，原始结果不变，继续按白名单校验', () => {
  const old = { summary: '已打开管理 · 会话', refs: [], receipt: { headline: '已打开管理 · 会话', detail: '', actions: [{ kind: 'open-management-page', page: 'sessions' }] } };
  const migrated = migrateLegacyManagementReceipt(old);
  assert.equal(Check(AssistantToolResultSchema, migrated), true);
  assert.deepEqual(migrated, { ...old, receipt: { ...old.receipt, actions: [{ kind: 'open-management-page', page: 'archive' }] } });
  assert.equal(old.receipt.actions[0]!.page, 'sessions');
  assert.equal(Check(AssistantToolResultSchema, migrateLegacyManagementReceipt({ ...old, secret: 'extra' })), false);
});

test('不改变正常会话打开、恢复和其他管理页操作；非法结果仍拒绝', () => {
  const actions = [{ kind: 'open-session', sessionId: 'a' }, { kind: 'restore-session', sessionId: 'b' }, { kind: 'open-management-page', page: 'models' }];
  const value = { summary: '结果', refs: [], receipt: { headline: '结果', detail: '', actions } };
  assert.deepEqual(migrateLegacyManagementReceipt(value), value);
  assert.equal(Check(AssistantToolResultSchema, migrateLegacyManagementReceipt({ ...value, receipt: { ...value.receipt, actions: [{ kind: 'open-management-page', page: 'gone' }] } })), false);
});
