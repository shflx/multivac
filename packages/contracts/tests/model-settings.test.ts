import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import {
  MODEL_SETTINGS_API_ERROR_CODES,
  ModelProfileInputSchema,
  ModelSettingsApiErrorResponseSchema,
  ModelSettingsSnapshotSchema,
  SaveModelSettingsSchema,
  SetDefaultModelSchema,
} from '../src/index.js';

const profile = {
  profileId: 'openai-main',
  displayName: 'OpenAI 主模型',
  provider: 'openai',
  modelId: 'gpt-5',
  protocol: 'openai-responses',
  endpoint: null,
} as const;

test('模型设置契约只接受受控配置字段和稳定命令标识', () => {
  assert.equal(Check(ModelProfileInputSchema, profile), true);
  assert.equal(Check(ModelProfileInputSchema, { ...profile, profileId: 'bad id' }), false);
  assert.equal(Check(ModelProfileInputSchema, { ...profile, protocol: 'custom-protocol' }), false);
  assert.equal(Check(ModelProfileInputSchema, { ...profile, apiKey: 'secret' }), false);

  assert.equal(Check(SaveModelSettingsSchema, {
    commandId: 'save:1',
    revision: 0,
    profile,
  }), true);
  assert.equal(Check(SaveModelSettingsSchema, {
    commandId: 'save:1',
    revision: 0,
    profile,
    token: 'secret',
  }), false);
  assert.equal(Check(SetDefaultModelSchema, {
    commandId: 'default:1',
    revision: 1,
    profileId: profile.profileId,
  }), true);
});

test('模型设置快照包含能力和只读可用性，不接受凭据', () => {
  const snapshot = {
    revision: 2,
    profiles: [{
      ...profile,
      capabilities: {
        source: 'pi-catalog',
        input: ['text', 'image'],
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        reasoning: true,
      },
    }],
    defaultProfileId: profile.profileId,
    availability: [{
      profileId: profile.profileId,
      authenticated: true,
      available: true,
      authenticationType: 'oauth',
      reason: null,
      message: null,
    }],
  };
  assert.equal(Check(ModelSettingsSnapshotSchema, snapshot), true);
  assert.equal(Check(ModelSettingsSnapshotSchema, {
    ...snapshot,
    profiles: [{ ...snapshot.profiles[0], apiKey: 'secret' }],
  }), false);
});

test('模型设置错误响应只接受安全错误码', () => {
  for (const code of MODEL_SETTINGS_API_ERROR_CODES) {
    assert.equal(Check(ModelSettingsApiErrorResponseSchema, {
      error: { code, message: '安全错误信息。' },
    }), true, code);
  }
  assert.equal(Check(ModelSettingsApiErrorResponseSchema, {
    error: { code: 'PI_RAW_ERROR', message: 'raw' },
  }), false);
});

test('@multivac/contracts 的模型设置契约不依赖 Node、存储或 Pi SDK', async () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
  const source = await readFile(resolve(sourceRoot, 'model-settings.ts'), 'utf8');

  assert.equal(source.includes('node:'), false);
  assert.equal(source.includes('@earendil-works/pi-'), false);
  assert.equal(/sqlite|better-sqlite/u.test(source), false);
});
