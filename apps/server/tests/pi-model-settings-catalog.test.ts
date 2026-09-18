import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import type { ModelProfileInput } from '@multivac/contracts';
import { ModelSettingsCandidateError } from '../src/modules/model-settings/model-settings.js';
import {
  PiModelSettingsCatalogFactory,
  mapPiModelCapabilities,
  buildPiModelsConfig,
  refreshPiModelCatalog,
} from '../src/runtime/executors/pi-model-settings-catalog.js';

test('同一目录模型使用显式兼容协议时保留推理及等级映射，不丢为缺省能力', () => {
  const model = { ...runtimeModel, provider: 'deepseek', id: 'deepseek-flash', api: 'openai-completions',
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' } };
  const target = { ...profile, provider: 'deepseek', modelId: model.id, protocol: 'anthropic-messages' as const,
    endpoint: 'https://api.deepseek.com/anthropic' };
  const { config, catalogCapabilityKeys } = buildPiModelsConfig([target], runtimeWith(model));
  const configured = config.providers.deepseek.models![0]!;
  assert.equal(config.providers.deepseek.api, 'anthropic-messages');
  assert.equal(configured.reasoning, true);
  assert.deepEqual(configured.thinkingLevelMap, model.thinkingLevelMap);
  assert.deepEqual(configured.compat, { forceAdaptiveThinking: true });
  assert.equal(catalogCapabilityKeys.size, 1);
  const plain = buildPiModelsConfig([target], runtimeWith({ ...model, reasoning: false }));
  assert.equal(plain.config.providers.deepseek.models![0]!.reasoning, false);
  assert.equal(plain.config.providers.deepseek.models![0]!.compat, undefined);
});

test('未知模型通过 Pi refresh 解析最新目录，只刷新相关 Provider 并支持缓存回退', async () => {
  const calls: unknown[] = [];
  let refreshed = false;
  const runtime = { getModel: () => refreshed ? runtimeModel : undefined,
    refresh: async (options: Parameters<ModelRuntime['refresh']>[0]) => {
      calls.push(options); refreshed = true;
      return { aborted: false, errors: new Map() };
    } };
  await refreshPiModelCatalog(runtime, [profile, profile]);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { providers: string[] }).providers, ['custom']);
  assert.equal((calls[0] as { allowNetwork: boolean }).allowNetwork, true);
  await refreshPiModelCatalog(runtime, [profile]);
  assert.equal(calls.length, 1);
});

test('真实 Pi 目录刷新缓存与 Anthropic 兼容推理实际传递 effort，不仅修改展示', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-reasoning-'));
  let payload: Record<string, unknown> | undefined;
  let catalogRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/models/providers/deepseek') {
      catalogRequests++;
      response.writeHead(200, { 'content-type': 'application/json', 'last-modified': 'Fri, 01 Jan 2100 00:00:00 GMT' });
      response.end(JSON.stringify([{ ...runtimeModel, provider: 'deepseek', id: 'deepseek-flash',
        api: 'openai-completions', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' } }]));
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      payload = JSON.parse(body);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'local payload probe' } }));
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const authPath = join(root, 'auth.json');
    const modelsPath = join(root, 'models.json');
    const modelsStorePath = join(root, 'models-store.json');
    await writeFile(authPath, JSON.stringify({ deepseek: { type: 'api_key', key: 'local-test-only' } }), { mode: 0o600 });
    await writeFile(modelsPath, '{"providers":{}}');
    const options = { authPath, modelsPath, modelsStorePath, catalogBaseUrl: local, allowModelNetwork: false };
    const base = await ModelRuntime.create(options);
    const target = { ...profile, provider: 'deepseek', modelId: 'deepseek-flash',
      protocol: 'anthropic-messages' as const, endpoint: `${local}/anthropic` };
    await refreshPiModelCatalog(base, [target]);
    assert.equal(catalogRequests, 1);
    assert.equal(base.getModel(target.provider, target.modelId)?.reasoning, true);
    const { config } = buildPiModelsConfig([target], base);
    await writeFile(modelsPath, JSON.stringify(config));
    const runtime = await ModelRuntime.create(options);
    const model = runtime.getModel(target.provider, target.modelId)!;
    assert.equal(model.reasoning, true);
    assert.equal(model.api, 'anthropic-messages');
    await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] },
      { reasoning: 'low', maxTokens: 64, maxRetries: 0 });
    assert.equal((payload?.thinking as { type: string }).type, 'adaptive');
    assert.deepEqual(payload?.output_config, { effort: 'low' });
    // 网络关闭时，SDK 仍能恢复已经解析的目录元数据。
    const reopened = await ModelRuntime.create(options);
    assert.equal(reopened.getModel(target.provider, target.modelId)?.reasoning, true);
    assert.equal(catalogRequests, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

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
