import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  ModelAvailability,
  ModelProfileInput,
} from '@multivac/contracts';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import {
  ModelSettingsCandidateError,
  ModelSettingsServiceError,
  type ModelSettingsCatalog,
  type ModelSettingsCatalogFactory,
  type ModelSettingsStore,
  type StoredModelSettingsState,
} from '../src/modules/model-settings/model-settings.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';

function profile(overrides: Partial<ModelProfileInput> = {}): ModelProfileInput {
  return {
    profileId: 'profile-main',
    displayName: '主模型',
    provider: 'custom-provider',
    modelId: 'model-main',
    protocol: 'openai-responses',
    endpoint: 'https://models.example/v1',
    ...overrides,
  };
}

class TestCatalog implements ModelSettingsCatalog {
  constructor(private readonly unavailableProviders: Set<string>) {}

  async inspect(profiles: readonly ModelProfileInput[]) {
    const capabilities = new Map(profiles.map((item) => [item.profileId, {
      source: 'pi-catalog' as const,
      input: ['text', 'image'] as const,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoning: true,
    }]));
    const availability: ModelAvailability[] = profiles.map((item) => {
      const available = !this.unavailableProviders.has(item.provider);
      return {
        profileId: item.profileId,
        authenticated: available,
        available,
        authenticationType: available ? 'api_key' : null,
        reason: available ? null : 'AUTH_MISSING',
        message: available ? null : 'Pi 当前未检测到有效认证。',
      };
    });
    const resolvedModels = new Map(profiles.map((item) => [item.profileId, {
      protocol: item.protocol,
      endpoint: item.endpoint ?? `https://${item.provider}.example/v1`,
    }] as const));
    return { capabilities, availability, resolvedModels };
  }
}

class TestCatalogFactory implements ModelSettingsCatalogFactory {
  readonly created: ModelProfileInput[][] = [];
  readonly strictProfileIds: string[][] = [];

  constructor(private readonly unavailableProviders = new Set<string>()) {}

  async create(
    profiles: readonly ModelProfileInput[],
    options: { strictProfileIds?: readonly string[] } = {},
  ): Promise<ModelSettingsCatalog> {
    this.created.push(structuredClone(profiles));
    this.strictProfileIds.push([...(options.strictProfileIds ?? [])]);
    if (profiles.some((item) =>
      options.strictProfileIds?.includes(item.profileId) && item.modelId === 'reject-me')) {
      throw new ModelSettingsCandidateError('候选模型配置未通过 Pi 校验。');
    }
    return new TestCatalog(this.unavailableProviders);
  }
}

async function fixture(unavailableProviders = new Set<string>()) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-settings-'));
  const path = join(root, 'model-settings.json');
  const factory = new TestCatalogFactory(unavailableProviders);
  const service = new ModelSettingsService(new FileModelSettingsStore(path), factory);
  await service.initialize();
  return { root, path, factory, service };
}

test('模型配置校验字段、HTTP(S) URL、userinfo 和 Provider 组合', async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.service.save({
        commandId: 'save:userinfo',
        revision: 0,
        profile: profile({ endpoint: 'https://user:secret@models.example/v1' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID' &&
        !error.message.includes('secret'),
    );
    for (const endpoint of [
      'https://models.example/v1?token=must-not-leak',
      'https://models.example/v1#must-not-leak',
    ]) {
      await assert.rejects(
        context.service.save({
          commandId: `save:unsafe-url:${endpoint.includes('?') ? 'query' : 'fragment'}`,
          revision: 0,
          profile: profile({ endpoint }),
        }),
        (error: unknown) => error instanceof ModelSettingsServiceError &&
          error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID' &&
          !error.message.includes('must-not-leak'),
      );
    }
    await assert.rejects(readFile(context.path, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(
      context.service.save({
        commandId: 'save:ftp',
        revision: 0,
        profile: profile({ endpoint: 'ftp://models.example/v1' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID',
    );

    const saved = await context.service.save({
      commandId: 'save:first',
      revision: 0,
      profile: profile(),
    });
    assert.equal(saved.revision, 1);
    await assert.rejects(
      context.service.save({
        commandId: 'save:provider-conflict',
        revision: 1,
        profile: profile({
          profileId: 'profile-second',
          modelId: 'model-second',
          protocol: 'openai-completions',
        }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID',
    );
    assert.equal((await context.service.getSnapshot()).revision, 1);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('快照固定同一 revision、profile 集和 catalog，延迟 inspect 不与并发保存混合', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-snapshot-race-'));
  let releaseInspect!: () => void;
  let markInspectStarted!: () => void;
  const inspectStarted = new Promise<void>((resolve) => { markInspectStarted = resolve; });
  const inspectGate = new Promise<void>((resolve) => { releaseInspect = resolve; });
  let createCount = 0;
  const factory: ModelSettingsCatalogFactory = {
    async create() {
      createCount += 1;
      if (createCount === 1) {
        return {
          async inspect(profiles) {
            markInspectStarted();
            await inspectGate;
            return new TestCatalog(new Set()).inspect(profiles);
          },
        };
      }
      return new TestCatalog(new Set());
    },
  };
  const store = new FileModelSettingsStore(join(root, 'settings.json'), {
    initialState: {
      revision: 0,
      profiles: [profile({ displayName: '旧名称' })],
      defaultProfileId: null,
      commands: [],
    },
  });
  const service = new ModelSettingsService(store, factory);
  await service.initialize();

  try {
    const oldSnapshotPromise = service.getSnapshot();
    await inspectStarted;
    const savePromise = service.save({
      commandId: 'save:during-inspect',
      revision: 0,
      profile: profile({ displayName: '新名称' }),
    });
    const saved = await savePromise;
    releaseInspect();
    const oldSnapshot = await oldSnapshotPromise;

    assert.equal(saved.revision, 1);
    assert.equal(saved.profiles[0]?.displayName, '新名称');
    assert.equal(oldSnapshot.revision, 0);
    assert.equal(oldSnapshot.profiles[0]?.displayName, '旧名称');
  } finally {
    releaseInspect();
    await rm(root, { recursive: true, force: true });
  }
});

test('保存命令支持幂等 ID，拒绝复用和 revision 冲突', async () => {
  const context = await fixture();
  try {
    const command = {
      commandId: 'save:idempotent',
      revision: 0,
      profile: profile(),
    } as const;
    const first = await context.service.save(command);
    const replay = await context.service.save(command);
    assert.equal(first.revision, 1);
    assert.equal(replay.revision, 1);
    assert.equal(context.factory.created.length, 2);

    await assert.rejects(
      context.service.save({
        ...command,
        profile: profile({ displayName: '不同负载' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_COMMAND_ID_CONFLICT',
    );
    await assert.rejects(
      context.service.save({
        commandId: 'save:stale',
        revision: 0,
        profile: profile({ displayName: '过期页面' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CONFLICT',
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('默认模型仅接受 Pi 当前已认证且可用的 profile', async () => {
  const context = await fixture(new Set(['missing-auth']));
  try {
    let snapshot = await context.service.save({
      commandId: 'save:available',
      revision: 0,
      profile: profile(),
    });
    snapshot = await context.service.save({
      commandId: 'save:unavailable',
      revision: snapshot.revision,
      profile: profile({
        profileId: 'profile-unavailable',
        provider: 'missing-auth',
        modelId: 'model-unavailable',
      }),
    });
    await assert.rejects(
      context.service.setDefault({
        commandId: 'default:unavailable',
        revision: snapshot.revision,
        profileId: 'profile-unavailable',
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'DEFAULT_MODEL_UNAVAILABLE',
    );
    const selected = await context.service.setDefault({
      commandId: 'default:available',
      revision: snapshot.revision,
      profileId: 'profile-main',
    });
    assert.equal(selected.defaultProfileId, 'profile-main');
    assert.deepEqual(await context.service.getDefaultModelForNewSession(), {
      source: 'controlled',
      provider: 'custom-provider',
      modelId: 'model-main',
      protocol: 'openai-responses',
      endpoint: 'https://models.example/v1',
      resolvedEndpoint: 'https://models.example/v1',
      profileId: 'profile-main',
    });
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('失效默认模型阻止新会话选择且保留默认引用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-invalid-default-'));
  const service = new ModelSettingsService(new FileModelSettingsStore(join(root, 'settings.json'), {
    initialState: {
      revision: 0,
      profiles: [profile({ provider: 'missing-auth' })],
      defaultProfileId: 'profile-main',
      commands: [],
    },
  }), new TestCatalogFactory(new Set(['missing-auth'])));
  await service.initialize();
  try {
    await assert.rejects(service.getDefaultModelForNewSession(), (error: unknown) =>
      error instanceof ModelSettingsServiceError && error.code === 'DEFAULT_MODEL_UNAVAILABLE');
    assert.equal((await service.getSnapshot()).defaultProfileId, 'profile-main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同 provider/modelId 的失效协议 profile 不能借用可用状态设为默认', async () => {
  const valid = profile({ endpoint: null, profileId: 'valid-protocol' });
  const invalid = profile({
    endpoint: null,
    profileId: 'invalid-protocol',
    protocol: 'openai-completions',
  });
  const factory: ModelSettingsCatalogFactory = {
    async create() {
      return {
        async inspect(profiles) {
          return {
            capabilities: new Map(profiles.map((item) => [item.profileId, {
              source: 'pi-catalog' as const,
              input: ['text'] as const,
              contextWindow: 128_000,
              maxOutputTokens: 16_384,
              reasoning: false,
            }])),
            availability: profiles.map((item) => item.profileId === valid.profileId
              ? {
                  profileId: item.profileId,
                  authenticated: true,
                  available: true,
                  authenticationType: 'api_key' as const,
                  reason: null,
                  message: null,
                }
              : {
                  profileId: item.profileId,
                  authenticated: false,
                  available: false,
                  authenticationType: null,
                  reason: 'MODEL_NOT_FOUND' as const,
                  message: 'Pi 当前目录中未找到该模型。',
                }),
            resolvedModels: new Map(profiles.map((item) => [item.profileId, {
              protocol: item.protocol,
              endpoint: `https://${item.provider}.example/v1`,
            }] as const)),
          };
        },
      };
    },
  };
  const service = new ModelSettingsService(new FileModelSettingsStore('/unused', {
    initialState: {
      revision: 0,
      profiles: [valid, invalid],
      defaultProfileId: null,
      commands: [],
    },
  }), factory);
  await service.initialize();
  await assert.rejects(
    service.setDefault({ commandId: 'default:wrong-protocol', revision: 0, profileId: invalid.profileId }),
    (error: unknown) => error instanceof ModelSettingsServiceError &&
      error.code === 'DEFAULT_MODEL_UNAVAILABLE',
  );
});

test('候选验证失败保留旧配置，重启恢复 revision、默认引用和幂等记录', async () => {
  const context = await fixture();
  try {
    let snapshot = await context.service.save({
      commandId: 'save:persisted',
      revision: 0,
      profile: { ...profile(), apiKey: 'must-not-persist' } as ModelProfileInput,
    });
    snapshot = await context.service.setDefault({
      commandId: 'default:persisted',
      revision: snapshot.revision,
      profileId: 'profile-main',
    });
    const beforeFailure = await readFile(context.path, 'utf8');

    await assert.rejects(
      context.service.save({
        commandId: 'save:rejected',
        revision: snapshot.revision,
        profile: profile({ modelId: 'reject-me' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID',
    );
    assert.equal(await readFile(context.path, 'utf8'), beforeFailure);
    assert.equal(beforeFailure.includes('apiKey'), false);
    assert.equal(beforeFailure.includes('must-not-persist'), false);
    assert.equal(beforeFailure.includes('token'), false);

    const restartedFactory = new TestCatalogFactory();
    const restarted = new ModelSettingsService(
      new FileModelSettingsStore(context.path),
      restartedFactory,
    );
    await restarted.initialize();
    const restored = await restarted.getSnapshot();
    assert.equal(restored.revision, 2);
    assert.equal(restored.defaultProfileId, 'profile-main');
    assert.equal(restored.profiles[0]?.displayName, '主模型');

    const replay = await restarted.setDefault({
      commandId: 'default:persisted',
      revision: 1,
      profileId: 'profile-main',
    });
    assert.equal(replay.revision, 2);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('未变更的失效旧 profile 不阻塞其它保存，修改自身仍执行严格候选校验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-legacy-profile-'));
  const path = join(root, 'settings.json');
  const factory = new TestCatalogFactory();
  const service = new ModelSettingsService(new FileModelSettingsStore(path, {
    initialState: {
      revision: 0,
      profiles: [
        profile({ profileId: 'legacy', modelId: 'reject-me' }),
        profile({ profileId: 'healthy', provider: 'healthy-provider', modelId: 'healthy-model' }),
      ],
      defaultProfileId: 'legacy',
      commands: [],
    },
  }), factory);
  await service.initialize();

  try {
    const saved = await service.save({
      commandId: 'save:healthy-only',
      revision: 0,
      profile: profile({
        profileId: 'healthy',
        displayName: '健康配置已更新',
        provider: 'healthy-provider',
        modelId: 'healthy-model',
      }),
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.defaultProfileId, 'legacy');
    assert.equal(saved.profiles.find((item) => item.profileId === 'legacy')?.modelId, 'reject-me');
    assert.deepEqual(factory.strictProfileIds.at(-1), ['healthy']);

    await assert.rejects(
      service.save({
        commandId: 'save:legacy-changed',
        revision: 1,
        profile: profile({ profileId: 'legacy', modelId: 'reject-me', displayName: '尝试修改' }),
      }),
      (error: unknown) => error instanceof ModelSettingsServiceError &&
        error.code === 'MODEL_SETTINGS_CANDIDATE_INVALID',
    );
    assert.equal((await service.getSnapshot()).revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('存储写失败时保留旧内存配置和旧持久化内容', async () => {
  class FailingStore implements ModelSettingsStore {
    state: StoredModelSettingsState = {
      revision: 0,
      profiles: [profile({ displayName: '写入前' })],
      defaultProfileId: null,
      commands: [],
    };
    failWrites = true;

    async load() { return structuredClone(this.state); }
    async save(state: StoredModelSettingsState) {
      if (this.failWrites) throw new Error('disk failed');
      this.state = structuredClone(state);
    }
  }

  const store = new FailingStore();
  const service = new ModelSettingsService(store, new TestCatalogFactory());
  await service.initialize();
  await assert.rejects(
    service.save({
      commandId: 'save:disk-failure',
      revision: 0,
      profile: profile({ displayName: '不应生效' }),
    }),
    (error: unknown) => error instanceof ModelSettingsServiceError &&
      error.code === 'MODEL_SETTINGS_UNAVAILABLE',
  );
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.profiles[0]?.displayName, '写入前');
  assert.equal(store.state.revision, 0);
});

test('手动推理能力随配置保存：auto 不写入文件，会话启动配置带上手动设置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'multivac-model-reasoning-'));
  try {
    const path = join(directory, 'model-settings.json');
    const service = new ModelSettingsService(new FileModelSettingsStore(path), new FakeCatalogFactoryForReasoning());
    await service.initialize();
    await service.save({ commandId: 'save-auto', revision: 0, profile: profile({ reasoning: 'auto' }) });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).profiles[0].reasoning, undefined);
    assert.equal((await service.getSnapshot()).profiles[0]?.reasoning, 'auto');
    assert.equal((await service.getModelProfileRuntimeConfig('profile-main')).reasoning, undefined);

    await service.save({ commandId: 'save-enabled', revision: 1, profile: profile({ reasoning: 'enabled' }) });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).profiles[0].reasoning, 'enabled');
    assert.equal((await service.getSnapshot()).profiles[0]?.reasoning, 'enabled');
    assert.equal((await service.getModelProfileRuntimeConfig('profile-main')).reasoning, true);
    await service.setDefault({ commandId: 'default', revision: 2, profileId: 'profile-main' });
    assert.equal((await service.getDefaultModelForNewSession())?.reasoning, true);
    assert.deepEqual(await service.getProfileReasoning('profile-main'), { reasoning: true });
    assert.equal(await service.getProfileReasoning('missing'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeCatalogFactoryForReasoning implements ModelSettingsCatalogFactory {
  async create(): Promise<ModelSettingsCatalog> {
    return new TestCatalog(new Set());
  }
}
