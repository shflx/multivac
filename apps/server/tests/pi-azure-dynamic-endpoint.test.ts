import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { resolvePiRequestEndpoint } from '../src/runtime/executors/pi-model-auth.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const environmentNames = [
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION',
  'MULTIVAC_AZURE_TEST_SECRET',
];

for (const { environmentMode, fallback } of [
  { environmentMode: 'base-url', fallback: null },
  { environmentMode: 'resource-name', fallback: null },
  { environmentMode: 'base-url', fallback: 'https://catalog-a.openai.azure.com/' },
  { environmentMode: 'resource-name', fallback: 'https://catalog-a.openai.azure.com/' },
]) {
  for (const interrupted of [false, true]) {
    test(`真实 SDK Azure ${fallback ? '目录A+环境B' : '空目录'} ${environmentMode} 首次与${interrupted ? '无 binding 中断' : 'binding'}恢复保留动态端点`, async () => {
      const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
      process.env.AZURE_OPENAI_API_KEY = 'test-azure-key-not-persisted';
      process.env.AZURE_OPENAI_API_VERSION = 'v1';
      process.env.MULTIVAC_AZURE_TEST_SECRET = 'test-native-secret';
      delete process.env.AZURE_OPENAI_BASE_URL;
      delete process.env.AZURE_OPENAI_RESOURCE_NAME;
      const environmentUrl = 'https://test-base.openai.azure.com/';
      if (environmentMode === 'base-url') process.env.AZURE_OPENAI_BASE_URL = environmentUrl;
      else process.env.AZURE_OPENAI_RESOURCE_NAME = 'test-resource';
      const root = await mkdtemp(join(tmpdir(), 'multivac-azure-dynamic-'));
      const cwd = join(root, 'workspace');
      const agentDir = join(root, 'agent');
      const sessionDir = join(root, 'sessions');
      await mkdir(cwd, { recursive: true });
      await mkdir(agentDir, { recursive: true });
      if (fallback !== null) await writeFile(join(agentDir, 'models.json'), JSON.stringify({
        providers: { 'azure-openai-responses': { baseUrl: fallback } },
      }));
      const databasePath = join(root, 'data.sqlite');
      const recoveryRoot = join(root, 'recovery');
      const recovery = new FileModelSelectionRecoveryRepository(recoveryRoot);
      const adapters: PiCoordinatorAdapter[] = [];
      let store = new SqliteAssistantStore(databasePath);
      let originalPiSessionId = '';
      let sdkCalls = 0;
      let lastRuntime: ModelRuntime | undefined;
      try {
        const original = await ModelRuntime.create({
          authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false,
        });
        const model = original.getModels('azure-openai-responses')[0];
        assert.ok(model);
        assert.equal(model.api, 'azure-openai-responses');
        assert.equal(model.baseUrl, fallback ?? '');
        const config: CoordinatorRuntimeConfig = {
          systemPrompt: '你是 Multivac。', authorizedContext: [],
          model: { source: 'base', provider: model.provider, modelId: model.id, thinkingLevel: 'off' },
          retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
          compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
        };
        const createAdapter = () => {
          const factory = new DefaultPiCoordinatorSessionFactory({
            createModelRuntime: async (options) => {
              assert.equal(options.modelsPath, join(agentDir, 'models.json'));
              lastRuntime = await ModelRuntime.create(options);
              return lastRuntime;
            },
            createAgentSession: async (options) => {
              sdkCalls += 1;
              assert.equal(options.model!.baseUrl, fallback ?? '');
              const manager = options.sessionManager!;
              const intent = await recovery.get(manager.getSessionId());
              assert.equal(intent?.endpointMode, 'pi-native-dynamic');
              assert.equal(intent?.endpoint, fallback);
              assert.equal(intent?.resolvedEndpoint, null);
              originalPiSessionId ||= manager.getSessionId();
              assert.equal(manager.getSessionId(), originalPiSessionId);
              return createAgentSession(options);
            },
          });
          const adapter = new PiCoordinatorAdapter({ cwd, agentDir, sessionDir, sessionFactory: factory });
          adapters.push(adapter);
          return adapter;
        };
        const createService = (adapter: PiCoordinatorAdapter, failBinding = false, recovering = false) =>
          new AssistantSessionService({
            adapter,
            bindingRepository: {
              get: (id) => store.getBinding(id),
              insertIfAbsent: (binding) => {
                if (failBinding) throw new Error('test binding write failed');
                return store.insertIfAbsent(binding);
              },
            },
            pageStateRepository: store, runtimeConfig: config,
            modelSelectionRecoveryRepository: new FileModelSelectionRecoveryRepository(recoveryRoot),
            ...(recovering ? {
              resolveNewSessionRuntimeConfig: async () => { throw new Error('恢复不能消费新默认'); },
            } : {}),
          });
        const assertNativeRequest = async (runtime: ModelRuntime, expectedHost: string) => {
          const requests: URL[] = [];
          const response = await runtime.completeSimple(runtime.getModel(model.provider, model.id)!, {
            messages: [{ role: 'user', content: 'test request', timestamp: Date.now() }],
          }, {
            maxRetries: 0,
            fetch: async (input) => {
              requests.push(new URL(input instanceof Request ? input.url : String(input)));
              return new Response('{"error":{"message":"test request stopped"}}', {
                status: 400, headers: { 'content-type': 'application/json' },
              });
            },
          });
          assert.equal(response.stopReason, 'error');
          assert.equal(requests.length, 1);
          assert.equal(requests[0]!.hostname, expectedHost);
          assert.equal(requests[0]!.pathname, '/openai/v1/responses');
          assert.equal(requests[0]!.searchParams.get('api-version'), 'v1');
        };
        const first = createService(createAdapter(), interrupted);
        if (interrupted) await assert.rejects(first.initialize(), /binding write failed/u);
        else {
          const binding = await first.initialize();
          assert.equal(binding.modelSource, 'base');
          assert.equal(binding.modelEndpointMode, 'pi-native-dynamic');
          assert.equal(binding.modelEndpoint, fallback);
          assert.equal(binding.modelResolvedEndpoint, null);
        }
        assert.equal(sdkCalls, 1);
        const expectedHost = environmentMode === 'base-url' ? 'test-base.openai.azure.com' : 'test-resource.openai.azure.com';
        await assertNativeRequest(lastRuntime!, expectedHost);
        adapters[0]!.dispose();
        store.close();
        store = new SqliteAssistantStore(databasePath);
        // Pi 初始化并不要求环境端点已配置；下一次请求仍交由 Azure SDK 原生解析。
        delete process.env.AZURE_OPENAI_BASE_URL;
        delete process.env.AZURE_OPENAI_RESOURCE_NAME;
        const restored = await createService(createAdapter(), false, true).initialize();
        assert.equal(sdkCalls, 2);
        assert.equal(restored.piSessionId, originalPiSessionId);
        assert.equal(restored.modelSource, 'base');
        assert.equal(restored.modelProtocol, 'azure-openai-responses');
        assert.equal(restored.modelEndpointMode, 'pi-native-dynamic');
        assert.equal(restored.modelEndpoint, fallback);
        assert.equal(restored.modelResolvedEndpoint, null);
        assert.equal(restored.modelProfileId, undefined);
        assert.equal((await readdir(sessionDir)).length, 1);

        if (environmentMode === 'base-url') process.env.AZURE_OPENAI_BASE_URL = environmentUrl;
        else process.env.AZURE_OPENAI_RESOURCE_NAME = 'test-resource';
        await assertNativeRequest(lastRuntime!, expectedHost);
        if (fallback !== null) {
          delete process.env.AZURE_OPENAI_BASE_URL;
          delete process.env.AZURE_OPENAI_RESOURCE_NAME;
          await assertNativeRequest(lastRuntime!, 'catalog-a.openai.azure.com');
        }
        const record = await recovery.get(restored.piSessionId);
        assert.equal(record?.endpointMode, 'pi-native-dynamic');
        assert.equal(record?.resolvedEndpoint, null);
        assert.equal(record?.endpoint, fallback);
        assert.equal(JSON.stringify({ restored, record }).includes('test-native-secret'), false);
        assert.equal(/test-base\.openai|test-resource\.openai/u.test(JSON.stringify({ restored, record })), false);
        assert.equal(JSON.stringify({ restored, record }).includes('test-azure-key-not-persisted'), false);
        assert.equal((await readFile(databasePath)).includes(Buffer.from('test-azure-key-not-persisted')), false);
      } finally {
        for (const adapter of adapters) adapter.dispose();
        store.close();
        for (const [name, value] of previousEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test('Azure 基础协议始终环境优先，安全 fallback 不绕过受控端点或 OAuth 检查', async () => {
  const model = { provider: 'azure-openai-responses', id: 'model', api: 'azure-openai-responses', baseUrl: '' };
  const runtime = { getAuth: async () => ({ auth: {} }) };
  assert.deepEqual(await resolvePiRequestEndpoint(runtime, model, null, 'base'), {
    mode: 'pi-native-dynamic', endpoint: null, fallback: null,
  });
  await assert.rejects(resolvePiRequestEndpoint(runtime, model));
  await assert.rejects(resolvePiRequestEndpoint(runtime, model, 'https://explicit.example/v1'));
  assert.deepEqual(await resolvePiRequestEndpoint(runtime, { ...model, provider: 'custom' }, null, 'base'), {
    mode: 'pi-native-dynamic', endpoint: null, fallback: null,
  });
  const oauth = { getAuth: async () => ({ auth: { baseUrl: 'https://oauth.example/v1' } }) };
  await assert.rejects(resolvePiRequestEndpoint(oauth, model, 'https://explicit.example/v1'));
  assert.deepEqual(await resolvePiRequestEndpoint(oauth, model, null, 'base'), {
    mode: 'pi-native-dynamic', endpoint: null, fallback: 'https://oauth.example/v1',
  });
  assert.deepEqual(await resolvePiRequestEndpoint(runtime, {
    ...model, baseUrl: 'https://catalog-a.example/v1',
  }, null, 'base'), {
    mode: 'pi-native-dynamic', endpoint: null, fallback: 'https://catalog-a.example/v1',
  });
  await assert.rejects(resolvePiRequestEndpoint(runtime, {
    ...model, baseUrl: 'https://user:password@catalog-a.example/v1',
  }, null, 'base'));
});
