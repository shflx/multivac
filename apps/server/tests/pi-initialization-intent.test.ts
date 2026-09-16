import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AssistantPageState, CoordinatorRuntimeConfig, CoordinatorSessionBinding } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import type { ModelSelectionRecoveryRecord } from '../src/modules/sessions/model-selection-recovery.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: {
    source: 'controlled',
    provider: 'test', modelId: 'model', thinkingLevel: 'off', profileId: 'managed-model',
    protocol: 'openai-responses', endpoint: 'https://proxy.example/v1',
    resolvedEndpoint: 'https://proxy.example/v1',
  },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

const model = {
  provider: 'test', id: 'model', name: 'Model', api: 'openai-responses',
  baseUrl: 'https://proxy.example/v1', reasoning: false, input: ['text'],
  contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const runtime = {
  getModel: () => model,
  hasConfiguredAuth: () => true,
  getAuth: async () => ({ auth: {} }),
} as unknown as ModelRuntime;

class Bindings {
  binding: CoordinatorSessionBinding | undefined;
  get() { return this.binding; }
  insertIfAbsent(binding: CoordinatorSessionBinding) {
    const inserted = this.binding === undefined;
    this.binding ??= binding;
    return { binding: this.binding, inserted };
  }
}

function service(adapter: PiCoordinatorAdapter, recovery: FileModelSelectionRecoveryRepository,
  bindings = new Bindings(), resolveDefault = async () => config) {
  const state: AssistantPageState = { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 };
  return new AssistantSessionService({
    adapter, bindingRepository: bindings,
    pageStateRepository: { get: () => state, save: (_id, value) => value },
    runtimeConfig: config, resolveNewSessionRuntimeConfig: resolveDefault,
    modelSelectionRecoveryRepository: recovery,
  });
}

test('真实 SDK 前先写初始化意图，恢复写失败不发布 session，重试可以继续', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-intent-order-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const order: string[] = [];
  let sdkCalls = 0;
  class Recovery extends FileModelSelectionRecoveryRepository {
    fail = true;
    override async saveIfAbsent(record: ModelSelectionRecoveryRecord) {
      assert.equal(existsSync(record.piSessionPath), false);
      order.push('intent');
      if (this.fail) throw new Error('intent storage unavailable');
      return super.saveIfAbsent(record);
    }
  }
  const recovery = new Recovery(join(root, 'recovery'));
  const factory = new DefaultPiCoordinatorSessionFactory({
    createModelRuntime: async () => runtime,
    createAgentSession: async (options) => {
      sdkCalls += 1;
      const manager = options.sessionManager!;
      const record = await recovery.get(manager.getSessionId());
      assert.ok(record);
      assert.equal(record.phase, 'initialization-intent');
      assert.equal(record.piSessionPath, manager.getSessionFile());
      assert.equal(manager.getBranch().length, 0);
      order.push('sdk');
      return createAgentSession(options);
    },
  });
  const adapter = new PiCoordinatorAdapter({ cwd, agentDir, sessionDir, sessionFactory: factory });
  const target = service(adapter, recovery);
  try {
    await assert.rejects(target.initialize());
    assert.equal(sdkCalls, 0);
    assert.deepEqual(await readdir(sessionDir), []);
    recovery.fail = false;
    const binding = await target.initialize();
    assert.deepEqual(order, ['intent', 'intent', 'sdk']);
    const entries = (await readFile(binding.piSessionPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(entries.map((entry) => entry.type), [
      'session', 'model_change', 'thinking_level_change',
    ]);
  } finally {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('真实 SDK 已写 model/thinking 后失败会 dispose，重启按意图恢复而不套新默认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-intent-reconcile-'));
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const recoveryRoot = join(root, 'recovery');
  const recovery = new FileModelSelectionRecoveryRepository(recoveryRoot);
  let failedSessionId = '';
  let disposeCalls = 0;
  const firstFactory = new DefaultPiCoordinatorSessionFactory({
    createModelRuntime: async () => runtime,
    createAgentSession: async (options) => {
      assert.ok(await recovery.get(options.sessionManager!.getSessionId()));
      const result = await createAgentSession(options);
      failedSessionId = result.session.sessionId;
      assert.deepEqual(result.session.sessionManager.getBranch().map((entry) => entry.type), [
        'model_change', 'thinking_level_change',
      ]);
      const dispose = result.session.dispose.bind(result.session);
      result.session.dispose = () => { disposeCalls += 1; dispose(); };
      result.session.getActiveToolNames = () => [];
      return result;
    },
  });
  const firstAdapter = new PiCoordinatorAdapter({ cwd, agentDir, sessionDir, sessionFactory: firstFactory });
  let secondAdapter: PiCoordinatorAdapter | undefined;
  try {
    await assert.rejects(service(firstAdapter, recovery).initialize());
    assert.equal(disposeCalls, 1);
    const record = await recovery.get(failedSessionId);
    assert.ok(record);
    assert.equal(existsSync(record.piSessionPath), true);
    firstAdapter.dispose();

    const secondFactory = new DefaultPiCoordinatorSessionFactory({
      createModelRuntime: async () => runtime,
      createAgentSession,
    });
    secondAdapter = new PiCoordinatorAdapter({ cwd, agentDir, sessionDir, sessionFactory: secondFactory });
    let defaultCalled = false;
    const restored = await service(
      secondAdapter,
      new FileModelSelectionRecoveryRepository(recoveryRoot),
      new Bindings(),
      async () => { defaultCalled = true; return config; },
    ).initialize();
    assert.equal(defaultCalled, false);
    assert.equal(restored.piSessionId, failedSessionId);
    assert.equal(restored.modelProtocol, 'openai-responses');
    assert.equal(restored.modelResolvedEndpoint, 'https://proxy.example/v1');
  } finally {
    firstAdapter.dispose();
    secondAdapter?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
