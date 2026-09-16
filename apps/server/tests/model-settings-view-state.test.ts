import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelAccessSnapshot, ModelSettingsSnapshot } from '@multivac/contracts';
import { admitAccessSnapshot, mergeModelSettings, normalizeAccessSnapshot } from '../../web/src/features/models/model-settings-view-state.js';

const models: ModelSettingsSnapshot = { revision: 0, profiles: [{ profileId: 'a', displayName: 'A', provider: 'provider',
  modelId: 'model', protocol: 'openai-responses', endpoint: 'https://provider.example/v1', capabilities: null }], defaultProfileId: null,
  availability: [{ profileId: 'a', authenticated: true, available: true, authenticationType: 'api_key', reason: null, message: null }] };
const access: ModelAccessSnapshot = { revision: 1, credentialRevision: 3, accessRevision: 4,
  credentials: [{ profileId: 'a', provider: 'provider', storedApiKey: false, configurable: true, lastCommand: null }],
  checks: [{ profileId: 'a', checkId: 'check', status: 'invalidated', checkedAt: null, expiresAt: null, errorCode: 'CHECK_INVALIDATED' }],
  availability: [{ profileId: 'a', authenticated: false, available: false, authenticationType: null, reason: 'AUTH_MISSING', message: 'missing' }] };

test('完整 access 准入跨 profile 生命周期保留凭据、能力门禁和检查，拒绝任一旧版本', () => {
  for (const stale of [{ ...access, revision: 0 }, { ...access, accessRevision: 3 }, { ...access, credentialRevision: 2 }]) {
    assert.equal(admitAccessSnapshot(access, stale), access);
  }
});
test('save/default/reload 等无凭据版本回执统一保留 access 认证，旧配置不可回滚', () => {
  const receipt = { ...models, revision: 1, defaultProfileId: 'a' };
  const committed = mergeModelSettings(models, receipt, access);
  assert.deepEqual(committed.availability, access.availability);
  assert.deepEqual(mergeModelSettings(committed, models, access), committed);
  const ahead = mergeModelSettings(committed, { ...receipt, revision: 2 }, access);
  assert.equal(ahead.availability.length, 1);
  assert.ok(ahead.availability.every((entry) => !entry.authenticated && !entry.available));
});

test('按接收/当前时间归一化过期，同 checkId 同版本 expired 不被乱序响应回滚', () => {
  const passed: ModelAccessSnapshot = { ...access, checks: [{ ...access.checks[0]!, status: 'passed',
    errorCode: null, checkedAt: new Date(0).toISOString(), expiresAt: new Date(100).toISOString() }] };
  assert.equal(admitAccessSnapshot(null, passed, 90).checks[0]?.status, 'passed');
  const expired = normalizeAccessSnapshot(passed, 101);
  assert.equal(expired.checks[0]?.status, 'expired');
  assert.equal(admitAccessSnapshot(null, passed, 101).checks[0]?.status, 'expired');
  const lateFuture = { ...passed, checks: [{ ...passed.checks[0]!, expiresAt: new Date(999).toISOString() }] };
  assert.equal(admitAccessSnapshot(expired, lateFuture, 101).checks[0]?.status, 'expired');
  assert.equal(admitAccessSnapshot(passed, { ...passed, accessRevision: 0 }, 101).checks[0]?.status, 'expired');
  const fresh = { ...lateFuture, accessRevision: access.accessRevision + 1, checks: [{ ...lateFuture.checks[0]!, checkId: 'new-check' }] };
  assert.equal(admitAccessSnapshot(expired, fresh, 101).checks[0]?.status, 'passed');
});
