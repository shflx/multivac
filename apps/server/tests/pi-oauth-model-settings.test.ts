import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, ModelRuntime, type CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig, ModelProfileInput } from '@multivac/contracts';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import {
  ModelSettingsCandidateError,
  ModelSettingsServiceError,
  type StoredModelSettingsState,
} from '../src/modules/model-settings/model-settings.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';

function credentials(): NonNullable<CreateModelRuntimeOptions['credentials']> {
  type Store = NonNullable<CreateModelRuntimeOptions['credentials']>;
  let credential: Awaited<ReturnType<Store['read']>> = {
    type: 'oauth', access: 'tid=test;proxy-ep=proxy.enterprise.example',
    refresh: 'test-refresh-not-used', expires: Date.now() + 3_600_000,
  };
  let tail = Promise.resolve();
  return {
    read: async (id) => id === 'github-copilot' ? credential : undefined,
    list: async () => credential ? [{ providerId: 'github-copilot', type: credential.type }] : [],
    modify: (id, fn) => {
      const result = tail.then(async () => {
        if (id !== 'github-copilot') return undefined;
        credential = (await fn(credential)) ?? credential;
        return credential;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    delete: async (id) => { if (id === 'github-copilot') credential = undefined; },
  };
}

test('真实 Pi OAuth auth.baseUrl 覆盖自定义端点时拒绝候选、可用状态与默认选择', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-oauth-override-'));
  const auth = credentials();
  try {
    const base = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
    const model = base.getModels('github-copilot').find((candidate) => candidate.api === 'openai-responses');
    assert.ok(model);
    assert.equal((await base.getAuth(model))?.auth.baseUrl, 'https://api.enterprise.example');
    const profile: ModelProfileInput = {
      profileId: 'copilot-proxy', displayName: 'Copilot Proxy', provider: model.provider,
      modelId: model.id, protocol: 'openai-responses', endpoint: 'https://requested.example/v1',
    };
    const factory = new PiModelSettingsCatalogFactory({
      candidateRoot: root,
      createRuntime: (options) => ModelRuntime.create({ ...options, credentials: auth }),
    });
    await assert.rejects(
      factory.create([profile], { strictProfileIds: [profile.profileId] }),
      ModelSettingsCandidateError,
    );
    const catalog = await factory.create([profile], { strictProfileIds: [] });
    const inspection = await catalog.inspect([profile]);
    assert.equal(inspection.availability[0]?.available, false);
    assert.equal(inspection.availability[0]?.reason, 'CONFIGURATION_INVALID');
    assert.equal(inspection.resolvedModels.has(profile.profileId), false);
    let state: StoredModelSettingsState = {
      revision: 0, profiles: [profile], defaultProfileId: profile.profileId, commands: [],
    };
    const service = new ModelSettingsService({
      load: async () => state, save: async (next) => { state = next; },
    }, factory);
    await service.initialize();
    await assert.rejects(service.getDefaultModelForNewSession(), (error: unknown) =>
      error instanceof ModelSettingsServiceError && error.code === 'DEFAULT_MODEL_UNAVAILABLE');
    await assert.rejects(service.setDefault({
      commandId: 'oauth-invalid-default', revision: 0, profileId: profile.profileId,
    }), (error: unknown) => error instanceof ModelSettingsServiceError &&
      error.code === 'DEFAULT_MODEL_UNAVAILABLE');
    const snapshot = await service.getSnapshot();
    assert.equal(/tid=test|test-refresh|proxy-ep/u.test(JSON.stringify(snapshot)), false);

    // 不一刀切禁用 OAuth：自定义端点与真实认证端点一致时可接受。
    const matching = { ...profile, endpoint: 'https://api.enterprise.example' };
    const valid = await factory.create([matching], { strictProfileIds: [matching.profileId] });
    assert.equal((await valid.inspect([matching])).availability[0]?.available, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('官方 OAuth 记录有效 auth endpoint，创建与已有 session 恢复均核验该端点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-official-oauth-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const auth = credentials();
  const sessions: { dispose(): void }[] = [];
  try {
    const base = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
    const model = base.getModels('github-copilot').find((candidate) => candidate.api === 'openai-responses');
    assert.ok(model);
    const profile: ModelProfileInput = {
      profileId: 'official-copilot', displayName: 'Official Copilot', provider: model.provider,
      modelId: model.id, protocol: 'openai-responses', endpoint: null,
    };
    const catalogFactory = new PiModelSettingsCatalogFactory({
      candidateRoot: join(root, 'candidates'),
      createRuntime: (options) => ModelRuntime.create({ ...options, credentials: auth }),
    });
    const catalog = await catalogFactory.create([profile], { strictProfileIds: [profile.profileId] });
    const resolved = (await catalog.inspect([profile])).resolvedModels.get(profile.profileId);
    assert.equal(resolved?.endpoint, 'https://api.enterprise.example');
    const config: CoordinatorRuntimeConfig = {
      systemPrompt: '你是 Multivac。', authorizedContext: [],
      model: {
        source: 'controlled', provider: profile.provider, modelId: profile.modelId,
        profileId: profile.profileId, thinkingLevel: 'off', protocol: profile.protocol,
        endpoint: null, resolvedEndpoint: resolved!.endpoint,
      },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
      compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
    };
    const recovery = new FileModelSelectionRecoveryRepository(join(root, 'recovery'));
    const factory = new DefaultPiCoordinatorSessionFactory({
      createModelRuntime: (options) => ModelRuntime.create({ ...options, credentials: auth }),
      createAgentSession,
    });
    const created = await factory.create({
      cwd, agentDir, sessionDir, config,
      persistModelSelectionRecovery: async (input) => {
        await recovery.saveIfAbsent({
          version: 1, phase: 'initialization-intent', selectionKind: input.model.source!,
          assistantSessionId: 'global-coordinator', piSessionId: input.piSessionId,
          piSessionPath: input.piSessionPath, provider: input.model.provider, modelId: input.model.modelId,
          profileId: input.model.profileId!, protocol: input.model.protocol!, endpoint: input.model.endpoint!,
          resolvedEndpoint: input.model.resolvedEndpoint!, createdAt: '2026-09-16T08:00:00.000Z',
        });
      },
    });
    sessions.push(created.session);
    assert.equal(created.appliedModelConfig.source, 'controlled');
    assert.equal(created.appliedModelConfig.endpoint, null);
    assert.equal(created.appliedModelConfig.resolvedEndpoint, 'https://api.enterprise.example');
    assert.notEqual(created.session.model!.baseUrl, created.appliedModelConfig.resolvedEndpoint);
    const record = await recovery.get(created.session.sessionId);
    assert.equal(record?.resolvedEndpoint, 'https://api.enterprise.example');
    assert.equal(/tid=test|test-refresh|proxy-ep/u.test(JSON.stringify(record)), false);
    created.session.dispose();
    const input = { cwd, agentDir, sessionDir, config, sessionPath: created.session.sessionFile! };
    const reopened = await factory.open(input);
    sessions.push(reopened.session);
    reopened.session.dispose();
    await auth.modify('github-copilot', async (credential) => ({
      ...credential!, type: 'oauth', access: 'tid=test;proxy-ep=proxy.changed.example',
    }));
    await assert.rejects(factory.open(input), /认证解析后的端点/u);
    await assert.rejects(factory.create({
      ...input,
      config: { ...config, model: { ...config.model, endpoint: 'https://requested.example/v1' } },
    }), /认证解析后的端点/u);
  } finally {
    for (const session of sessions) session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
