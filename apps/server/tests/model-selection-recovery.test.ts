import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AssistantPageState,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
} from '@multivac/contracts';
import { AssistantSessionService, AssistantSessionServiceError } from '../src/application/assistant-session-service.js';
import type {
  AssistantPageStateRepository,
  AssistantSessionBindingRepository,
} from '../src/modules/sessions/assistant-session.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';

const baseConfig: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'base', modelId: 'base-model', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

class MemoryBindings implements AssistantSessionBindingRepository {
  binding: CoordinatorSessionBinding | undefined;
  failInsert = false;

  get() { return this.binding; }
  insertIfAbsent(binding: CoordinatorSessionBinding) {
    if (this.failInsert) throw new Error('binding write failed');
    const inserted = this.binding === undefined;
    this.binding ??= binding;
    return { binding: this.binding, inserted };
  }
}

class MemoryPageState implements AssistantPageStateRepository {
  state: AssistantPageState = { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 };
  get() { return this.state; }
  save(_assistantSessionId: string, state: AssistantPageState) { this.state = state; return state; }
}

test('不可变模型选择恢复文件幂等且不含凭据，冲突记录被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-model-recovery-store-'));
  const repository = new FileModelSelectionRecoveryRepository(root);
  const record = {
    version: 1 as const,
    phase: 'initialization-intent' as const,
    selectionKind: 'controlled' as const,
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-recovery',
    piSessionPath: '/sessions/pi-recovery.jsonl',
    provider: 'custom-provider',
    modelId: 'custom-model',
    profileId: 'profile-custom',
    protocol: 'openai-completions' as const,
    endpoint: 'https://custom.example/v1',
    resolvedEndpoint: 'https://custom.example/v1',
    createdAt: '2026-09-16T08:00:00.000Z',
  };

  try {
    assert.deepEqual(await repository.saveIfAbsent(record), record);
    assert.deepEqual(await repository.saveIfAbsent({
      ...record,
      createdAt: '2026-09-16T09:00:00.000Z',
    }), record);
    await assert.rejects(repository.saveIfAbsent({ ...record, modelId: 'other-model' }));
    const [fileName] = await readdir(root);
    const content = await readFile(join(root, fileName!), 'utf8');
    assert.equal(/apiKey|token|secret|authorization/iu.test(content), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('binding 写失败或进程中断后重启按恢复记录重建完整模型选择', async () => {
  const selections = [{
    name: 'unknown-custom',
    model: {
      source: 'controlled' as const,
      provider: 'custom-provider',
      modelId: 'custom-model',
      thinkingLevel: 'off' as const,
      profileId: 'profile-custom',
      protocol: 'openai-completions' as const,
      endpoint: 'https://custom.example/v1',
      resolvedEndpoint: 'https://custom.example/v1',
    },
  }, {
    name: 'known-custom-endpoint',
    model: {
      source: 'controlled' as const,
      provider: 'openai',
      modelId: 'gpt-known',
      thinkingLevel: 'off' as const,
      profileId: 'profile-known-proxy',
      protocol: 'openai-responses' as const,
      endpoint: 'https://proxy.example/v1',
      resolvedEndpoint: 'https://proxy.example/v1',
    },
  }];

  for (const selection of selections) {
    const root = await mkdtemp(join(tmpdir(), `multivac-recovery-${selection.name}-`));
    const recovery = new FileModelSelectionRecoveryRepository(join(root, 'recovery'));
    const firstBindings = new MemoryBindings();
    firstBindings.failInsert = true;
    const first = new AssistantSessionService({
      adapter: new FakeCoordinatorAdapter({ sessionPathRoot: join(root, 'sessions') }),
      bindingRepository: firstBindings,
      pageStateRepository: new MemoryPageState(),
      runtimeConfig: baseConfig,
      resolveNewSessionRuntimeConfig: async () => ({ ...baseConfig, model: selection.model }),
      modelSelectionRecoveryRepository: recovery,
      now: () => '2026-09-16T08:00:00.000Z',
    });

    try {
      await assert.rejects(first.initialize(), /binding write failed/u);
      const record = await recovery.get('pi-fake-global-coordinator');
      assert.ok(record);
      assert.equal(record.provider, selection.model.provider);
      assert.equal(record.modelId, selection.model.modelId);
      assert.equal(record.protocol, selection.model.protocol);
      assert.equal(record.resolvedEndpoint, selection.model.resolvedEndpoint);

      let newDefaultResolverCalled = false;
      const secondBindings = new MemoryBindings();
      const second = new AssistantSessionService({
        adapter: new FakeCoordinatorAdapter({
          sessionPathRoot: join(root, 'sessions'),
          continueRecentResumesExisting: true,
          recentSessionModel: selection.model,
        }),
        bindingRepository: secondBindings,
        pageStateRepository: new MemoryPageState(),
        runtimeConfig: baseConfig,
        resolveNewSessionRuntimeConfig: async () => {
          newDefaultResolverCalled = true;
          return baseConfig;
        },
        modelSelectionRecoveryRepository: recovery,
      });
      const restored = await second.initialize();
      assert.equal(newDefaultResolverCalled, false);
      assert.equal(restored.modelProvider, selection.model.provider);
      assert.equal(restored.modelId, selection.model.modelId);
      assert.equal(restored.modelProtocol, selection.model.protocol);
      assert.equal(restored.modelResolvedEndpoint, selection.model.resolvedEndpoint);
      assert.equal(restored.modelProfileId, selection.model.profileId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('恢复记录缺失或损坏时返回明确恢复错误且不套用新默认', async () => {
  for (const state of ['missing', 'corrupt'] as const) {
    const root = await mkdtemp(join(tmpdir(), `multivac-recovery-${state}-`));
    const recoveryRoot = join(root, 'recovery');
    const recovery = new FileModelSelectionRecoveryRepository(recoveryRoot);
    if (state === 'corrupt') {
      await recovery.saveIfAbsent({
        version: 1,
        phase: 'initialization-intent',
        selectionKind: 'base',
        assistantSessionId: 'global-coordinator',
        piSessionId: 'pi-fake-global-coordinator',
        piSessionPath: `${join(root, 'sessions')}/pi-fake-global-coordinator.jsonl`,
        provider: 'historical',
        modelId: 'historical-model',
        profileId: null,
        protocol: 'openai-responses',
        endpoint: 'https://historical.example/v1',
        resolvedEndpoint: 'https://historical.example/v1',
        createdAt: '2026-09-16T08:00:00.000Z',
      });
      const [fileName] = await readdir(recoveryRoot);
      await writeFile(join(recoveryRoot, fileName!), '{broken', 'utf8');
    }
    let defaultCalled = false;
    const service = new AssistantSessionService({
      adapter: new FakeCoordinatorAdapter({
        sessionPathRoot: join(root, 'sessions'),
        continueRecentResumesExisting: true,
        recentSessionModel: {
          provider: 'historical', modelId: 'historical-model', thinkingLevel: 'off',
        },
      }),
      bindingRepository: new MemoryBindings(),
      pageStateRepository: new MemoryPageState(),
      runtimeConfig: baseConfig,
      resolveNewSessionRuntimeConfig: async () => {
        defaultCalled = true;
        return baseConfig;
      },
      modelSelectionRecoveryRepository: recovery,
    });

    try {
      await assert.rejects(
        service.initialize(),
        (error: unknown) => error instanceof AssistantSessionServiceError &&
          error.code === 'ASSISTANT_SESSION_RECOVERY_FAILED' &&
          error.message.includes('恢复记录'),
      );
      assert.equal(defaultCalled, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('合法 JSON 的恢复记录关联语义损坏不能关闭隔离 runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-recovery-semantics-'));
  const repository = new FileModelSelectionRecoveryRepository(root);
  const record = {
    version: 1 as const, phase: 'initialization-intent' as const,
    selectionKind: 'controlled' as const, assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-semantic', piSessionPath: '/sessions/pi-semantic.jsonl',
    provider: 'custom', modelId: 'model', profileId: 'profile',
    protocol: 'openai-responses' as const, endpoint: 'https://proxy.example/v1',
    resolvedEndpoint: 'https://proxy.example/v1', createdAt: '2026-09-16T08:00:00.000Z',
  };
  try {
    await repository.saveIfAbsent(record);
    const [file] = await readdir(root);
    const path = join(root, file!);
    for (const corruption of [
      { protocol: null },
      { profileId: '' },
      { profileId: null },
      { selectionKind: 'base' },
      { resolvedEndpoint: null },
      { resolvedEndpoint: 'https://user:password@proxy.example/v1' },
      { resolvedEndpoint: 'https://proxy.example/v1?token=value' },
      { endpoint: 'https://other.example/v1' },
      { protocol: null, endpoint: null, resolvedEndpoint: null },
      { apiKey: 'not-permitted' },
      { piSessionId: 'other-session' },
      { protocol: 'openai-codex-responses' },
      { protocol: 'https://credential@host' },
      { endpointMode: 'pi-native-dynamic', endpoint: null, resolvedEndpoint: null },
    ]) {
      await writeFile(path, JSON.stringify({ ...record, ...corruption }), 'utf8');
      await assert.rejects(repository.get(record.piSessionId));
    }
    await writeFile(path, JSON.stringify({
      ...record, selectionKind: 'base', profileId: null,
    }), 'utf8');
    const base = await repository.get(record.piSessionId);
    assert.equal(base?.selectionKind, 'base');
    assert.equal(base?.protocol, 'openai-responses');
    assert.equal(base?.resolvedEndpoint, 'https://proxy.example/v1');
    await writeFile(path, JSON.stringify({
      ...record, selectionKind: 'base', profileId: null, protocol: 'openai-codex-responses',
      endpoint: 'https://catalog.example/v1', resolvedEndpoint: 'https://oauth.example/v1',
    }), 'utf8');
    const native = await repository.get(record.piSessionId);
    assert.equal(native?.protocol, 'openai-codex-responses');
    assert.equal(native?.endpoint, 'https://catalog.example/v1');
    assert.equal(native?.resolvedEndpoint, 'https://oauth.example/v1');
    const dynamic = {
      ...record, selectionKind: 'base', profileId: null,
      provider: 'azure-openai-responses', protocol: 'azure-openai-responses',
      endpointMode: 'pi-native-dynamic', endpoint: null, resolvedEndpoint: null,
    };
    await writeFile(path, JSON.stringify(dynamic), 'utf8');
    const azure = await repository.get(record.piSessionId);
    assert.equal(azure?.endpointMode, 'pi-native-dynamic');
    assert.equal(azure?.endpoint, null);
    assert.equal(azure?.resolvedEndpoint, null);
    for (const corruption of [
      { selectionKind: 'controlled', profileId: 'profile' },
      { protocol: 'openai-responses' },
      { endpoint: '' },
      { resolvedEndpoint: 'https://changed.example/v1' },
      { endpointMode: 'fixed' },
      { endpointMode: undefined },
    ]) {
      await writeFile(path, JSON.stringify({ ...dynamic, ...corruption }), 'utf8');
      await assert.rejects(repository.get(record.piSessionId));
    }
    await writeFile(path, JSON.stringify({ ...dynamic, endpoint: 'https://fallback.example/v1' }), 'utf8');
    assert.equal((await repository.get(record.piSessionId))?.endpoint, 'https://fallback.example/v1');
    await writeFile(path, JSON.stringify({ ...dynamic, endpoint: 'https://user:password@fallback.example/v1' }), 'utf8');
    await assert.rejects(repository.get(record.piSessionId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
