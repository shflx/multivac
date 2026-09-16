import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { ConfigureModelApiKeySchema, ModelAccessCommandSchema, ModelAccessReceiptSchema, ModelAccessSnapshotSchema, SaveModelSettingsSchema } from '../src/index.js';

test('Key 仅在独立秘密传输 DTO，拒绝空/控制字符；配置和安全账本契约不接受 Key/hash', () => {
  const command = { commandId: 'uuid', profileId: 'profile', revision: 0, accessRevision: 0 };
  assert.equal(Check(ConfigureModelApiKeySchema, { ...command, apiKey: 'secret-key' }), true);
  for (const apiKey of ['', 'key\nheader', 'key value']) assert.equal(Check(ConfigureModelApiKeySchema, { ...command, apiKey }), false);
  assert.equal(Check(ModelAccessCommandSchema, { ...command, apiKey: 'secret' }), false);
  const receipt = { replayed: false, commandId: 'uuid', profileId: 'profile', revision: 0, accessRevision: 1,
    action: 'configure-key', state: 'committed', errorCode: null };
  assert.equal(Check(ModelAccessReceiptSchema, receipt), true);
  assert.equal(Check(ModelAccessReceiptSchema, { ...receipt, apiKey: 'secret' }), false);
  assert.equal(Check(ModelAccessReceiptSchema, { ...receipt, payloadHash: 'secret-hash' }), false);
  assert.equal(Check(ModelAccessSnapshotSchema, { revision: 0, accessRevision: 1, credentialRevision: 1,
    availability: [], credentials: [], checks: [] }), true);
  assert.equal(Check(SaveModelSettingsSchema, { commandId: 'uuid', revision: 0, apiKey: 'secret' }), false);
});
