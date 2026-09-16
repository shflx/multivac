import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import type { ModelProfileInput } from '@multivac/contracts';
import { ModelSettingsCandidateError } from '../src/modules/model-settings/model-settings.js';
import {
  PiModelSettingsCatalogFactory,
  mapPiModelCapabilities,
} from '../src/runtime/executors/pi-model-settings-catalog.js';

const runtimeModel = {
  provider: 'custom',
  id: 'model',
  api: 'openai-responses',
  baseUrl: 'https://official.example/v1',
  reasoning: true,
  input: ['text', 'image'] as ('text' | 'image')[],
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const profile: ModelProfileInput = {
  profileId: 'custom-model',
  displayName: 'Custom Model',
  provider: 'custom',
  modelId: 'model',
  protocol: 'openai-responses',
  endpoint: 'https://models.example/v1',
};

function runtimeWith(model: typeof runtimeModel | undefined) {
  return {
    getModel: (provider: string, modelId: string) =>
      provider === model?.provider && modelId === model.id ? model : undefined,
    getAvailable: async () => model ? [model] : [],
    checkAuth: async () => ({ type: 'oauth' as const, source: 'stored credential' }),
    getAuth: async () => ({ auth: {} }),
  };
}

test('Pi 能力映射携带实际目录来源', () => {
  assert.deepEqual(mapPiModelCapabilities(runtimeModel), {
    source: 'pi-catalog',
    input: ['text', 'image'],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    reasoning: true,
  });
});

test('已知模型的自定义 endpoint 只覆盖 baseUrl，并保留 Pi 真实能力', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-known-model-'));
  const configs: unknown[] = [];
  try {
    const factory = new PiModelSettingsCatalogFactory({
      candidateRoot: root,
      createRuntime: async (options) => {
        configs.push(JSON.parse(await readFile(options.modelsPath!, 'utf8')) as unknown);
        if (configs.length === 1) return runtimeWith(runtimeModel);
        return runtimeWith({ ...runtimeModel, baseUrl: profile.endpoint! });
      },
    });
    const catalog = await factory.create([profile], { strictProfileIds: [profile.profileId] });
    const inspection = await catalog.inspect([profile]);

    assert.deepEqual(configs[1], {
      providers: { custom: { baseUrl: 'https://models.example/v1' } },
    });
    assert.deepEqual(inspection.capabilities.get(profile.profileId), {
      source: 'pi-catalog',
      input: ['text', 'image'],
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      reasoning: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('未知兼容模型使用 Pi 缺省能力并明确标记来源，配置不含凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-unknown-model-'));
  const configs: unknown[] = [];
  const defaultModel = {
    ...runtimeModel,
    baseUrl: profile.endpoint!,
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  let capturedOptions: CreateModelRuntimeOptions | undefined;
  try {
    const factory = new PiModelSettingsCatalogFactory({
      candidateRoot: root,
      createRuntime: async (options) => {
        capturedOptions = options;
        configs.push(JSON.parse(await readFile(options.modelsPath!, 'utf8')) as unknown);
        return configs.length === 1 ? runtimeWith(undefined) : runtimeWith(defaultModel);
      },
    });
    const catalog = await factory.create([profile], { strictProfileIds: [profile.profileId] });
    const inspection = await catalog.inspect([profile]);

    assert.equal(capturedOptions?.allowModelNetwork, false);
    assert.equal(capturedOptions?.refreshOnCreate, true);
    assert.deepEqual(configs[1], {
      providers: {
        custom: {
          baseUrl: 'https://models.example/v1',
          api: 'openai-responses',
          models: [{ id: 'model', name: 'Custom Model' }],
        },
      },
    });
    assert.equal(JSON.stringify(configs[1]).includes('apiKey'), false);
    assert.deepEqual(inspection.capabilities.get(profile.profileId), {
      source: 'pi-default',
      input: ['text'],
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoning: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('启动恢复保留 Pi 已移除的旧 profile，严格变更仍拒绝官方目录缺失', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-model-missing-'));
  const officialProfile = { ...profile, endpoint: null };
  try {
    const factory = new PiModelSettingsCatalogFactory({
      candidateRoot: root,
      createRuntime: async () => runtimeWith(undefined),
    });
    const restored = await factory.create([officialProfile], { strictProfileIds: [] });
    const inspection = await restored.inspect([officialProfile]);
    assert.deepEqual(inspection.availability, [{
      profileId: profile.profileId,
      authenticated: false,
      available: false,
      authenticationType: null,
      reason: 'MODEL_NOT_FOUND',
      message: 'Pi 当前目录中未找到该模型。',
    }]);
    await assert.rejects(
      factory.create([officialProfile], { strictProfileIds: [profile.profileId] }),
      ModelSettingsCandidateError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同 provider/modelId 不同 protocol 按完整维度隔离可用性', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-protocol-isolation-'));
  const valid = { ...profile, endpoint: null };
  const invalid = {
    ...valid,
    profileId: 'custom-model-wrong-protocol',
    protocol: 'openai-completions' as const,
  };
  try {
    const factory = new PiModelSettingsCatalogFactory({
      candidateRoot: root,
      createRuntime: async () => runtimeWith(runtimeModel),
    });
    const catalog = await factory.create([valid, invalid], { strictProfileIds: [] });
    const inspection = await catalog.inspect([valid, invalid]);
    assert.equal(inspection.availability[0]?.available, true);
    assert.deepEqual(inspection.availability[1], {
      profileId: invalid.profileId,
      authenticated: false,
      available: false,
      authenticationType: null,
      reason: 'MODEL_NOT_FOUND',
      message: 'Pi 当前目录中未找到该模型。',
    });
    assert.equal(inspection.capabilities.get(invalid.profileId), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
