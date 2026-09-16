import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig, CoordinatorSessionBinding } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

for (const protocol of ['openai-responses', 'openai-codex-responses']) {
  for (const interrupted of [false, true]) {
    test(`基础 Pi 自定义 ${protocol} 首次及${interrupted ? '无 binding 中断' : 'binding'}恢复保留配置语义`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'multivac-base-recovery-'));
      const cwd = join(root, 'workspace');
      const agentDir = join(root, 'agent');
      const sessionDir = join(root, 'sessions');
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      const modelsPath = join(agentDir, 'models.json');
      const piConfig = {
        providers: {
          legacy: {
            api: protocol, baseUrl: 'https://legacy.example/v1',
            apiKey: 'test-pi-configured-key', headers: { 'X-Legacy': 'test-pi-header' },
            models: [{
              id: 'legacy-model', name: 'Legacy Model', reasoning: true,
              input: ['text', 'image'], contextWindow: 64_000, maxTokens: 4_096,
            }],
          },
        },
      };
      await writeFile(modelsPath, JSON.stringify(piConfig));
      const config: CoordinatorRuntimeConfig = {
        systemPrompt: '你是 Multivac。', authorizedContext: [],
        model: { source: 'base', provider: 'legacy', modelId: 'legacy-model', thinkingLevel: 'off' },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
        compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
      };
      const recovery = new FileModelSelectionRecoveryRepository(join(root, 'recovery'));
      const databasePath = join(root, 'data.sqlite');
      let store = new SqliteAssistantStore(databasePath);
      const adapters: PiCoordinatorAdapter[] = [];
      let sdkCalls = 0;
      let expectedHeader = 'test-pi-header';
      const makeAdapter = () => {
        const factory = new DefaultPiCoordinatorSessionFactory({
          createModelRuntime: async (options) => {
            assert.equal(options.modelsPath, modelsPath);
            return ModelRuntime.create(options);
          },
          createAgentSession: async (options) => {
            sdkCalls += 1;
            const runtime = options.modelRuntime!;
            const model = options.model!;
            assert.equal(model.api, protocol);
            assert.equal(model.contextWindow, 64_000);
            assert.equal(model.maxTokens, 4_096);
            assert.equal(model.reasoning, true);
            assert.deepEqual(model.input, ['text', 'image']);
            const auth = await runtime.getAuth(model);
            assert.equal(auth?.auth.apiKey, 'test-pi-configured-key');
            assert.equal(auth?.auth.headers?.['X-Legacy'], expectedHeader);
            return createAgentSession(options);
          },
        });
        const adapter = new PiCoordinatorAdapter({ cwd, agentDir, sessionDir, sessionFactory: factory });
        adapters.push(adapter);
        return adapter;
      };
      const makeService = (adapter: PiCoordinatorAdapter) => new AssistantSessionService({
        adapter,
        bindingRepository: {
          get: (id) => store.getBinding(id),
          insertIfAbsent: (binding) => store.insertIfAbsent(binding),
        },
        pageStateRepository: store,
        runtimeConfig: config,
        modelSelectionRecoveryRepository: recovery,
        resolveNewSessionRuntimeConfig: async () => { throw new Error('恢复不得套新默认'); },
      });
      try {
        const firstAdapter = makeAdapter();
        const firstService = new AssistantSessionService({
          adapter: firstAdapter,
          bindingRepository: {
            get: (id) => store.getBinding(id),
            insertIfAbsent: (binding) => {
              if (interrupted) throw new Error('test binding write failed');
              return store.insertIfAbsent(binding);
            },
          },
          pageStateRepository: store, runtimeConfig: config, modelSelectionRecoveryRepository: recovery,
        });
        let firstBinding: CoordinatorSessionBinding | undefined;
        if (interrupted) await assert.rejects(firstService.initialize(), /binding write failed/u);
        else firstBinding = await firstService.initialize();
        assert.equal(sdkCalls, 1);
        firstAdapter.dispose();
        store.close();
        store = new SqliteAssistantStore(databasePath);
        // 恢复读取当前原生 Pi 配置，而不是从无凭据恢复记录重建认证或 headers。
        expectedHeader = 'test-pi-updated-header';
        piConfig.providers.legacy.headers['X-Legacy'] = expectedHeader;
        await writeFile(modelsPath, JSON.stringify(piConfig));
        const restored = await makeService(makeAdapter()).initialize();
        assert.equal(sdkCalls, 2);
        assert.equal(restored.modelSource, 'base');
        assert.equal(restored.modelProtocol, protocol);
        assert.equal(restored.modelProfileId, undefined);
        assert.equal(restored.modelResolvedEndpoint, 'https://legacy.example/v1');
        if (firstBinding) assert.equal(restored.piSessionId, firstBinding.piSessionId);
        const record = await recovery.get(restored.piSessionId);
        assert.equal(record?.selectionKind, 'base');
        assert.equal(record?.protocol, protocol);
        assert.equal(/test-pi-configured-key|test-pi-header|test-pi-updated-header/u.test(
          JSON.stringify({ restored, record }),
        ), false);
        assert.equal((await readFile(databasePath)).includes(Buffer.from('test-pi-configured-key')), false);
        adapters.at(-1)!.dispose();
        // 基础配置仍不能借恢复语义静默切换固定端点。
        piConfig.providers.legacy.baseUrl = 'https://replacement.example/v1';
        await writeFile(modelsPath, JSON.stringify(piConfig));
        await assert.rejects(makeService(makeAdapter()).initialize());
        assert.equal(sdkCalls, 2);
      } finally {
        for (const adapter of adapters) adapter.dispose();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
