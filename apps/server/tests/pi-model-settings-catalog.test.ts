import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type CreateModelRuntimeOptions,
} from '@earendil-works/pi-coding-agent';
import type { ModelProfileInput } from '@multivac/contracts';
import { ModelSettingsCandidateError } from '../src/modules/model-settings/model-settings.js';
import {
  PiModelSettingsCatalogFactory,
  mapPiModelCapabilities,
  buildPiModelsConfig,
  piThinkingLevels,
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

test('手动推理能力以 Pi modelOverrides 覆盖目录与自定义模型，auto 不写覆盖', () => {
  const catalog = { ...profile, profileId: 'catalog', endpoint: null, reasoning: 'disabled' as const };
  const custom = { ...profile, provider: 'gateway', modelId: 'gpt-custom', reasoning: 'enabled' as const };
  const { config } = buildPiModelsConfig([catalog, custom], runtimeWith(runtimeModel));
  // 官方端点的目录模型只写覆盖，不补 baseUrl。
  assert.deepEqual(config.providers.custom, { modelOverrides: { model: { reasoning: false } } });
  assert.equal(config.providers.gateway.baseUrl, 'https://models.example/v1');
  assert.deepEqual(config.providers.gateway.modelOverrides, { 'gpt-custom': { reasoning: true } });

  const auto = buildPiModelsConfig([{ ...custom, reasoning: 'auto' }], runtimeWith(runtimeModel));
  assert.equal(auto.config.providers.gateway.modelOverrides, undefined);
});

test('真实 Pi 按手动推理能力解析模型：自定义 Responses 模型可开启推理，目录模型可关闭', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-reasoning-override-'));
  try {
    const options = { authPath: join(root, 'auth.json'), modelsStorePath: join(root, 'models-store.json'),
      allowModelNetwork: false };
    await writeFile(join(root, 'base.json'), '{"providers":{}}');
    const base = await ModelRuntime.create({ ...options, modelsPath: join(root, 'base.json') });
    const resolve = async (profiles: ModelProfileInput[]) => {
      const path = join(root, `${profiles.map((item) => item.profileId).join('-')}.json`);
      await writeFile(path, JSON.stringify(buildPiModelsConfig(profiles, base).config));
      return ModelRuntime.create({ ...options, modelsPath: path });
    };
    const custom: ModelProfileInput = { profileId: 'gateway', displayName: 'Gateway', provider: 'gateway',
      modelId: 'gpt-custom', protocol: 'openai-responses', endpoint: 'https://gateway.example/v1' };
    // 不在 Pi 目录中的自定义模型默认不支持推理。
    assert.equal((await resolve([custom])).getModel('gateway', 'gpt-custom')?.reasoning, false);
    const enabled = await resolve([{ ...custom, profileId: 'gateway-enabled', reasoning: 'enabled' }]);
    assert.equal(enabled.getModel('gateway', 'gpt-custom')?.reasoning, true);

    assert.equal(base.getModel('openai', 'gpt-5')?.reasoning, true);
    const disabled = await resolve([{ profileId: 'gpt5-disabled', displayName: 'GPT-5', provider: 'openai',
      modelId: 'gpt-5', protocol: 'openai-responses', endpoint: null, reasoning: 'disabled' }]);
    assert.equal(disabled.getModel('openai', 'gpt-5')?.reasoning, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
  });
});

test('推理等级按 Pi 的规则读取：不支持只有 off，映射为 null 的等级不可选，xhigh、max 需映射明确给出', () => {
  assert.deepEqual(piThinkingLevels({ reasoning: false }), ['off']);
  // 不支持推理时忽略映射，与 Pi 一致。
  assert.deepEqual(piThinkingLevels({ reasoning: false, thinkingLevelMap: { xhigh: 'xhigh' } }), ['off']);
  assert.deepEqual(piThinkingLevels({ reasoning: true }), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: 'minimal', xhigh: null, max: null } }),
    ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, xhigh: 'xhigh' } }),
    ['off', 'low', 'medium', 'high', 'xhigh']);
  // 映射可以有空洞：只给出 high 与 max。
  assert.deepEqual(piThinkingLevels({ reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' } }), ['off', 'high', 'max']);
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
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
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
      thinkingLevels: ['off'],
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

test('真实 Pi：模型能力中的推理等级与会话里 Pi 给出的可选等级一致，手动设置经 modelOverrides 计入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-thinking-levels-'));
  const agentDir = join(root, 'agent');
  let session: AgentSession | undefined;
  try {
    await mkdir(agentDir);
    const authPath = join(agentDir, 'auth.json');
    // 离线的假 Key 只用于让 Pi 会话接受换模型，不发任何请求。
    await writeFile(authPath, JSON.stringify(Object.fromEntries(['openai', 'anthropic', 'google', 'deepseek', 'gateway']
      .map((provider) => [provider, { type: 'api_key', key: 'offline-thinking-level-key' }]))), { mode: 0o600 });
    const options = { authPath, modelsStorePath: join(root, 'models-store.json'), allowModelNetwork: false };
    await writeFile(join(root, 'base.json'), '{"providers":{}}');
    const base = await ModelRuntime.create({ ...options, modelsPath: join(root, 'base.json') });
    const catalog = (provider: string, modelId: string, reasoning: ModelProfileInput['reasoning'] = 'auto'): ModelProfileInput => ({
      profileId: `${provider}-${modelId}-${reasoning}`.replaceAll('.', '_'), displayName: modelId, provider, modelId,
      protocol: base.getModel(provider, modelId)!.api as ModelProfileInput['protocol'], endpoint: null, reasoning,
    });
    const profiles: ModelProfileInput[] = [
      catalog('openai', 'gpt-5'),
      catalog('openai', 'gpt-5.2'),
      catalog('anthropic', 'claude-opus-4-7'),
      catalog('deepseek', 'deepseek-v4-pro'),
      // 目录中不支持推理的模型手动设为支持，目录中支持的手动设为不支持。
      catalog('openai', 'gpt-5-chat-latest', 'enabled'),
      catalog('openai', 'gpt-5-mini', 'disabled'),
      // 不在目录中的自定义模型：自动按 Pi 默认不支持，手动设为支持后是 Pi 的默认等级。
      { profileId: 'gateway-auto', displayName: 'Gateway', provider: 'gateway', modelId: 'gpt-custom',
        protocol: 'openai-responses', endpoint: 'https://gateway.example/v1' },
    ];
    const enabledCustom: ModelProfileInput = { ...profiles.at(-1)!, profileId: 'gateway-enabled', modelId: 'gpt-custom-enabled',
      reasoning: 'enabled' };
    profiles.push(enabledCustom);

    const factory = new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') });
    const inspection = await (await factory.create(profiles)).inspect(profiles);
    const levels = (profile: ModelProfileInput) => inspection.capabilities.get(profile.profileId)?.thinkingLevels;
    assert.deepEqual(levels(profiles[0]!), ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual(levels(profiles[1]!), ['off', 'low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(levels(profiles[2]!), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(levels(profiles[3]!), ['off', 'high', 'max']);
    assert.deepEqual(levels(profiles[4]!), ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual(levels(profiles[5]!), ['off']);
    assert.equal(inspection.capabilities.get('gateway-auto')?.reasoning, false);
    assert.deepEqual(levels(profiles[6]!), ['off']);
    assert.deepEqual(levels(enabledCustom), ['off', 'minimal', 'low', 'medium', 'high']);

    // 同一份模型构建交给真实 Pi 会话：换到每个模型后，会话可选的等级就是能力中的等级。
    await writeFile(join(root, 'candidate.json'), JSON.stringify(buildPiModelsConfig(profiles, base).config));
    const runtime = await ModelRuntime.create({ ...options, modelsPath: join(root, 'candidate.json') });
    session = (await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime,
      model: runtime.getModel('openai', 'gpt-5')!,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [] }),
      sessionManager: SessionManager.inMemory(root), noTools: 'all', tools: [] })).session;
    for (const profile of profiles) {
      await session.setModel(runtime.getModel(profile.provider, profile.modelId)!);
      assert.deepEqual(session.getAvailableThinkingLevels(), levels(profile), profile.profileId);
    }

    // 目录中这几个提供方的全部模型（含推理能力取反，相当于手动设置）逐一与 Pi 会话核对读取规则。
    for (const model of ['openai', 'anthropic', 'google', 'deepseek'].flatMap((provider) => base.getModels(provider))) {
      for (const variant of [model, { ...model, reasoning: !model.reasoning }]) {
        await session.setModel(variant);
        assert.deepEqual(session.getAvailableThinkingLevels(), piThinkingLevels(variant), `${model.provider}/${model.id}`);
      }
    }
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
