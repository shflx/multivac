import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig, ModelProfileInput } from '@multivac/contracts';
import { ModelSettingsServiceError } from '../src/modules/model-settings/model-settings.js';
import { AssistantSessionService, AssistantSessionServiceError } from '../src/application/assistant-session-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from '../src/application/new-session-runtime-config.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

for (const failure of ['missing-auth', 'unavailable', 'inspect-error', 'no-default', 'catalog-fault-no-default']) {
  test(`真实新会话 resolver 与 service：${failure} 不静默替代已设默认且可修复重试`, async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    const noDefault = failure === 'no-default' || failure === 'catalog-fault-no-default';
    delete process.env.OPENAI_API_KEY;
    const root = await mkdtemp(join(tmpdir(), 'multivac-default-acceptance-'));
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    const recoveryRoot = join(root, 'recovery');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const authPath = join(agentDir, 'auth.json');
    const baseAuth = { anthropic: { type: 'api_key', key: 'test-base-key' } };
    const fullAuth = { ...baseAuth, openai: { type: 'api_key', key: 'test-default-key' } };
    await writeFile(authPath, JSON.stringify(failure === 'missing-auth' || failure === 'no-default' ? baseAuth : fullAuth));
    let store = new SqliteAssistantStore(join(root, 'data.sqlite'));
    let adapter: PiCoordinatorAdapter | undefined;
    let repaired = false;
    let sdkCalls = 0;
    let runtimeCalls = 0;
    try {
      const probe = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
      const defaultModel = probe.getModels('openai').find((model) => model.api === 'openai-responses');
      const baseModel = probe.getModels('anthropic').find((model) => model.api === 'anthropic-messages');
      assert.ok(defaultModel && baseModel);
      const profile: ModelProfileInput = {
        profileId: 'selected-default', displayName: 'Selected Default', provider: defaultModel.provider,
        modelId: defaultModel.id, protocol: 'openai-responses', endpoint: null,
      };
      const config: CoordinatorRuntimeConfig = {
        systemPrompt: '你是 Multivac。', authorizedContext: [],
        model: { source: 'base', provider: baseModel.provider, modelId: baseModel.id, thinkingLevel: 'off' },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
      };
      const settings = new ModelSettingsService(new FileModelSettingsStore(join(root, 'settings.json'), {
        initialState: {
          revision: 0, profiles: [profile], defaultProfileId: noDefault ? null : profile.profileId,
          commands: [],
        },
      }), new PiModelSettingsCatalogFactory({
        candidateRoot: join(root, 'candidates'),
        createRuntime: async (options) => {
          if (failure === 'catalog-fault-no-default') throw new Error('test-runtime-secret');
          const runtime = await ModelRuntime.create({ ...options, authPath });
          return {
            getModel: runtime.getModel.bind(runtime),
            getAuth: runtime.getAuth.bind(runtime),
            checkAuth: runtime.checkAuth.bind(runtime),
            getAvailable: async (provider, operationOptions) => {
              if (!repaired && failure === 'inspect-error') throw new Error('test-runtime-secret');
              if (!repaired && failure === 'unavailable') return [];
              return runtime.getAvailable(provider, operationOptions);
            },
          };
        },
      }));
      await settings.initialize();
      const resolver = createNewSessionRuntimeConfigResolver(settings, config);
      const createAdapter = () => new PiCoordinatorAdapter({
        cwd, agentDir, sessionDir,
        sessionFactory: new DefaultPiCoordinatorSessionFactory({
          authPath,
          createModelRuntime: async (options) => { runtimeCalls += 1; return ModelRuntime.create(options); },
          createAgentSession: async (options) => {
            sdkCalls += 1;
            const expected = noDefault ? baseModel : defaultModel;
            assert.equal(options.model!.provider, expected.provider);
            assert.equal(options.model!.id, expected.id);
            return createAgentSession(options);
          },
        }),
      });
      const createService = (target: PiCoordinatorAdapter) => new AssistantSessionService({
        adapter: target,
        bindingRepository: {
          get: (id) => store.getBinding(id), insertIfAbsent: (binding) => store.insertIfAbsent(binding),
        },
        pageStateRepository: store, runtimeConfig: config,
        resolveNewSessionRuntimeConfig: resolver,
        modelSelectionRecoveryRepository: new FileModelSelectionRecoveryRepository(recoveryRoot),
      });
      adapter = createAdapter();
      const service = createService(adapter);
      if (!noDefault) {
        const isSafeDefaultError = (error: unknown) => error instanceof AssistantSessionServiceError &&
          error.code === 'DEFAULT_MODEL_UNAVAILABLE' &&
          !/test-runtime-secret|test-default-key|test-base-key/u.test(error.message);
        await assert.rejects(service.initialize(), isSafeDefaultError);
        await assert.rejects(service.getPageState(), isSafeDefaultError);
        assert.equal(store.getBinding('global-coordinator'), undefined);
        assert.equal(sdkCalls, 0);
        assert.equal(runtimeCalls, 0);
        assert.deepEqual(await readdir(sessionDir), []);
        await assert.rejects(readdir(recoveryRoot), (error: unknown) =>
          (error as NodeJS.ErrnoException).code === 'ENOENT');
        const snapshot = await settings.getSnapshot();
        assert.equal(snapshot.defaultProfileId, profile.profileId);
        assert.equal(snapshot.revision, 0);
        repaired = true;
        await writeFile(authPath, JSON.stringify(fullAuth));
      } else {
        assert.equal(await settings.getDefaultModelForNewSession(), null);
        assert.equal(await resolver(), config);
      }
      const binding = await service.initialize();
      assert.equal(sdkCalls, 1);
      assert.equal(binding.modelProvider, noDefault ? baseModel.provider : defaultModel.provider);
      assert.equal(binding.modelSource, noDefault ? 'base' : 'controlled');
      assert.equal(binding.modelProfileId, noDefault ? undefined : profile.profileId);
      if (failure === 'catalog-fault-no-default') {
        await assert.rejects(settings.getSnapshot(), (error: unknown) => error instanceof ModelSettingsServiceError &&
          error.code === 'MODEL_SETTINGS_UNAVAILABLE');
      } else {
        assert.equal((await settings.getSnapshot()).defaultProfileId, noDefault ? null : profile.profileId);
      }
      // 已保存绑定不会因之后默认状态变化而改用基础模型或创建替代会话。
      adapter.dispose();
      store.close();
      store = new SqliteAssistantStore(join(root, 'data.sqlite'));
      repaired = false;
      adapter = createAdapter();
      const restored = await createService(adapter).initialize();
      assert.equal(restored.piSessionId, binding.piSessionId);
      assert.equal(restored.modelProvider, binding.modelProvider);
      assert.equal(restored.modelId, binding.modelId);
      assert.equal((await readdir(sessionDir)).length, 1);
    } finally {
      adapter?.dispose();
      store.close();
      if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAIKey;
      await rm(root, { recursive: true, force: true });
    }
  });
}
