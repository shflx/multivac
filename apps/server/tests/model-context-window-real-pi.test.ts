import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig, ModelProfileInput } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionModelSelectionService } from '../src/application/session-model-selection-service.js';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from '../src/application/new-session-runtime-config.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { completedItems, controlledFetch, responsesSDK, terminal } from './fixtures/responses-stream.js';

// 真实 Pi SDK、配置文件、SQLite 与会话文件；只替换模型传输，不使用真实凭据或基础 Pi 配置。
test('受控 gpt-6.1-sol：新建、恢复、窗口换用、原生自动压缩和实际请求使用相同模型窗口', async () => {
  const root = await mkdtemp(join(process.cwd(), '.model-window-test-'));
  const agentDir = join(root, 'agent'); const cwd = join(root, 'work');
  await mkdir(agentDir); await mkdir(cwd);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ gateway: { type: 'api_key', key: 'offline-placeholder' } }), { mode: 0o600 });
  let store = new SqliteAssistantStore(join(root, 'database.sqlite'));
  const profile: ModelProfileInput = { profileId: 'sol', provider: 'gateway', modelId: 'gpt-6.1-sol', displayName: 'SOL',
    protocol: 'openai-responses', endpoint: 'https://gateway.example/v1' };
  const settings = new ModelSettingsService(new FileModelSettingsStore(join(root, 'settings.json')),
    new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }));
  const config: CoordinatorRuntimeConfig = { systemPrompt: '窗口验证', authorizedContext: [],
    model: { provider: 'gateway', modelId: 'gpt-6.1-sol', source: 'base', thinkingLevel: 'off' },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20 } };
  let actual!: AgentSession;
  const requests: number[] = [];
  let running = false;
  const adapters: PiCoordinatorAdapter[] = [];
  const make = () => {
    const adapter = new PiCoordinatorAdapter({ agentDir, modelsPath: null, sessionDir: join(root, 'sessions'),
      sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, modelsPath: null, temporaryRoot: root,
        createAgentSession: async options => {
          const result = await createAgentSession(options); actual = result.session;
          actual.agent.streamFunction = (model, context, options) => {
            requests.push(model.contextWindow);
            const source = controlledFetch([...completedItems(), terminal()]);
            return responsesSDK.streamSimple(model, context, { ...options, apiKey: 'controlled', fetch: source.fetch });
          };
          return result;
        } }) });
    adapters.push(adapter);
    const service = new AssistantSessionService({ adapter, bindingRepository: store.bindings, pageStateRepository: store.pageStates,
      selectionRepository: store.selections, runtimeConfig: config,
      resolveWorkingDirectory: () => ({ kind: 'session-temp', path: cwd }),
      resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(settings, config) });
    const selection = new SessionModelSelectionService({ adapter, sessionService: service, repository: store.selections, settings,
      lock: new AssistantOperationLock(), isRunning: () => running });
    return { adapter, service, selection };
  };
  const seed = () => {
    for (let index = 0; index < 4; index++) {
      actual.sessionManager.appendMessage({ role: 'user', content: `早期内容 ${index} ${'内容'.repeat(80)}`, timestamp: Date.now() });
      actual.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `回复 ${index}` }],
        api: 'openai-responses', provider: 'gateway', model: 'gpt-6.1-sol', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 9500, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9500,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    actual.agent.state.messages = actual.sessionManager.buildSessionContext().messages;
  };
  try {
    await settings.initialize();
    await settings.save({ commandId: 'large', revision: 0, profile: { ...profile, contextWindow: 1_000_000 } });
    await settings.setDefault({ commandId: 'default', revision: 1, profileId: 'sol' });
    const first = make(); const binding = await first.service.initialize();
    const readWindow = (adapter: PiCoordinatorAdapter) => {
      const state = adapter.contextManagement.readContext('global-coordinator'); assert.ok(state.ok);
      return state.value.current.contextWindow;
    };
    assert.equal(actual.model?.contextWindow, 1_000_000);
    assert.equal(readWindow(first.adapter), 1_000_000);
    seed();
    await actual.prompt('大窗口无需压缩');
    assert.equal(actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
    assert.equal(requests.at(-1), 1_000_000);
    first.adapter.dispose(); store.close(); store = new SqliteAssistantStore(join(root, 'database.sqlite'));
    const restored = make();
    assert.equal((await restored.service.initialize()).runtimeSessionId, binding.runtimeSessionId);
    assert.equal(actual.model?.contextWindow, 1_000_000);
    assert.equal(store.selections.getSelection('global-coordinator')?.model.contextWindow, 1_000_000);
    assert.equal((await restored.selection.getOptions()).selection.availability.available, true);
    running = true;
    await settings.save({ commandId: 'small', revision: 2, profile: { ...profile, contextWindow: 10_000 } });
    await restored.selection.getOptions();
    assert.equal(actual.model?.contextWindow, 1_000_000);
    running = false;
    await restored.selection.validateForSend();
    assert.equal(actual.model?.contextWindow, 10_000);
    assert.equal(readWindow(restored.adapter), 10_000);
    seed();
    const before = requests.length;
    await actual.prompt('小窗口触发自动压缩');
    assert.ok(actual.sessionManager.getBranch().some(entry => entry.type === 'compaction'));
    assert.ok(requests.length > before);
    assert.ok(requests.slice(before).every(window => window === 10_000));
    await settings.save({ commandId: 'clear', revision: 3, profile });
    await restored.selection.validateForSend();
    const original = (await settings.getSnapshot()).profiles[0]!.capabilities!.contextWindow;
    assert.equal(actual.model?.contextWindow, original);
    assert.equal(readWindow(restored.adapter), original);
    assert.equal(store.selections.getSelection('global-coordinator')?.model.contextWindow, undefined);
  } finally { for (const adapter of adapters) adapter.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
