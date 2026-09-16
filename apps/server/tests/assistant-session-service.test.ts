import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AssistantMessageView,
  AssistantPageState,
  CoordinatorRuntimeConfig,
  CoordinatorSessionBinding,
} from '@multivac/contracts';
import { AssistantSessionService, AssistantSessionServiceError } from '../src/application/assistant-session-service.js';
import type {
  AssistantPageStateRepository,
  AssistantSessionBindingRepository,
} from '../src/modules/sessions/assistant-session.js';
import { AssistantPageStateRevisionConflictError } from '../src/modules/sessions/assistant-session.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

class MemoryBindingRepository implements AssistantSessionBindingRepository {
  binding: CoordinatorSessionBinding | undefined;

  constructor(binding?: CoordinatorSessionBinding) {
    this.binding = binding;
  }

  get() {
    return this.binding;
  }

  insertIfAbsent(binding: CoordinatorSessionBinding) {
    const inserted = this.binding === undefined;
    this.binding ??= binding;
    return { binding: this.binding, inserted };
  }
}

class MemoryPageStateRepository implements AssistantPageStateRepository {
  state: AssistantPageState = { draft: '', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 };

  get() {
    return this.state;
  }

  save(_assistantSessionId: string, state: AssistantPageState) {
    if (state.revision !== this.state.revision) {
      throw new AssistantPageStateRevisionConflictError(this.state);
    }
    if (
      state.draft === this.state.draft &&
      state.anchorEntryId === this.state.anchorEntryId &&
      state.anchorOffsetPx === this.state.anchorOffsetPx
    ) {
      return this.state;
    }
    this.state = { ...state, revision: state.revision + 1 };
    return this.state;
  }
}

function history(count: number): AssistantMessageView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture:${index + 1}`,
    piSessionId: 'fixture',
    piEntryId: `entry-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `消息 ${index + 1}`,
    createdAt: '2026-09-14T08:00:00.000Z',
  }));
}

function service(
  adapter: FakeCoordinatorAdapter,
  bindings = new MemoryBindingRepository(),
  pageStates = new MemoryPageStateRepository(),
) {
  return new AssistantSessionService({
    adapter,
    bindingRepository: bindings,
    pageStateRepository: pageStates,
    runtimeConfig: config,
  });
}

test('首次初始化幂等接续最近会话并写入固定 binding', async () => {
  const adapter = new FakeCoordinatorAdapter();
  const bindings = new MemoryBindingRepository();
  const target = service(adapter, bindings);

  const [first, second] = await Promise.all([target.initialize(), target.initialize()]);

  assert.deepEqual(first, second);
  assert.equal(first.assistantSessionId, 'global-coordinator');
  assert.deepEqual(adapter.calls.map((call) => call.method), ['continueRecentSession']);
  assert.deepEqual(bindings.binding, first);
});

test('仅新会话消费默认模型，已有 binding 固定创建时模型', async () => {
  const newAdapter = new FakeCoordinatorAdapter();
  const newService = new AssistantSessionService({
    adapter: newAdapter,
    bindingRepository: new MemoryBindingRepository(),
    pageStateRepository: new MemoryPageStateRepository(),
    runtimeConfig: config,
    resolveNewSessionRuntimeConfig: async () => ({
      ...config,
      model: { ...config.model, provider: 'new-default', modelId: 'new-model' },
    }),
  });
  const newBinding = await newService.initialize();
  const createCall = newAdapter.calls.find((call) => call.method === 'continueRecentSession');
  assert.ok(createCall?.method === 'continueRecentSession');
  assert.deepEqual(createCall.input.config.model, config.model);
  assert.equal(newBinding.modelProvider, 'new-default');
  assert.equal(newBinding.modelId, 'new-model');

  let resolverCalled = false;
  const existingAdapter = new FakeCoordinatorAdapter();
  const existingBinding = {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-existing-model',
    piSessionPath: '/existing/model.jsonl',
    updatedAt: '2026-09-16T08:00:00.000Z',
    modelProvider: 'stored-provider',
    modelId: 'stored-model',
  };
  const existingService = new AssistantSessionService({
    adapter: existingAdapter,
    bindingRepository: new MemoryBindingRepository(existingBinding),
    pageStateRepository: new MemoryPageStateRepository(),
    runtimeConfig: config,
    resolveNewSessionRuntimeConfig: async () => {
      resolverCalled = true;
      return { ...config, model: { ...config.model, provider: 'later', modelId: 'later' } };
    },
  });
  await existingService.initialize();
  const restoreCall = existingAdapter.calls.find((call) => call.method === 'continueSession');
  assert.ok(restoreCall?.method === 'continueSession');
  assert.deepEqual(restoreCall.input.config.model, {
    source: 'base',
    provider: 'stored-provider', modelId: 'stored-model', thinkingLevel: 'off',
  });
  assert.equal(resolverCalled, false);
});

test('无 SQLite binding 但 Pi 有历史时不读取新默认并固定历史模型', async () => {
  let resolverCalled = false;
  const adapter = new FakeCoordinatorAdapter({
    continueRecentResumesExisting: true,
    recentSessionModel: {
      provider: 'historical-provider',
      modelId: 'historical-model',
      thinkingLevel: 'low',
    },
    history: history(2),
  });
  const target = new AssistantSessionService({
    adapter,
    bindingRepository: new MemoryBindingRepository(),
    pageStateRepository: new MemoryPageStateRepository(),
    runtimeConfig: config,
    resolveNewSessionRuntimeConfig: async () => {
      resolverCalled = true;
      return { ...config, model: { ...config.model, provider: 'new-default', modelId: 'new-model' } };
    },
  });

  const binding = await target.initialize();
  assert.equal(resolverCalled, false);
  assert.equal(binding.modelProvider, 'historical-provider');
  assert.equal(binding.modelId, 'historical-model');
  assert.equal(binding.modelProtocol, undefined);
  assert.deepEqual(adapter.calls.map((call) => call.method), ['continueRecentSession']);
});

test('已有绑定只按 binding open，失败时不创建替代会话', async () => {
  const binding = {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-existing',
    piSessionPath: '/existing/pi.jsonl',
    updatedAt: '2026-09-14T08:00:00.000Z',
  };
  class FailingAdapter extends FakeCoordinatorAdapter {
    override async continueSession() {
      return {
        ok: false as const,
        error: {
          code: 'SESSION_OPEN_FAILED' as const,
          message: 'open failed',
          recoverableBinding: binding,
        },
      };
    }
  }
  const adapter = new FailingAdapter();
  const target = service(adapter, new MemoryBindingRepository(binding));

  await assert.rejects(target.initialize(), (error: unknown) => {
    assert.ok(error instanceof AssistantSessionServiceError);
    assert.equal(error.code, 'ASSISTANT_SESSION_RECOVERY_FAILED');
    return true;
  });
  assert.equal(adapter.calls.some((call) => call.method === 'continueRecentSession'), false);
});

test('分页使用排他 entry 游标并保持 branch 顺序和去重', async () => {
  const adapter = new FakeCoordinatorAdapter({ history: [...history(6), history(1)[0]!] });
  const target = service(adapter);

  const latest = await target.getSessionPage({ limit: 3 });
  assert.deepEqual(latest.messages.map((message) => message.piEntryId), [
    'entry-4', 'entry-5', 'entry-6',
  ]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextBefore, 'entry-4');

  const earlier = await target.getSessionPage({ before: 'entry-4', limit: 3 });
  assert.deepEqual(earlier.messages.map((message) => message.piEntryId), [
    'entry-1', 'entry-2', 'entry-3',
  ]);
  assert.equal(earlier.hasMore, false);
  await assert.rejects(
    target.getSessionPage({ before: 'missing', limit: 3 }),
    (error: unknown) => error instanceof AssistantSessionServiceError && error.code === 'INVALID_CURSOR',
  );
});

test('并发初始化 loser 释放候选并恢复 winner binding', async () => {
  const winner = {
    assistantSessionId: 'global-coordinator',
    piSessionId: 'pi-winner',
    piSessionPath: '/winner/pi.jsonl',
    updatedAt: '2026-09-14T08:00:00.000Z',
  };
  const bindings = new MemoryBindingRepository();
  bindings.insertIfAbsent = () => ({ binding: winner, inserted: false });
  const adapter = new FakeCoordinatorAdapter();

  const initialized = await service(adapter, bindings).initialize();

  assert.deepEqual(initialized, winner);
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    'continueRecentSession', 'disposeSession', 'continueSession',
  ]);
});

test('页面状态保存 revision 冲突映射为稳定应用错误', async () => {
  const pageStates = new MemoryPageStateRepository();
  const target = service(new FakeCoordinatorAdapter(), new MemoryBindingRepository(), pageStates);
  const saved = await target.putPageState({
    draft: '草稿', anchorEntryId: 'entry-1', anchorOffsetPx: 12, revision: 0,
  });
  assert.equal(saved.revision, 1);
  await assert.rejects(
    target.putPageState({ draft: '旧草稿', anchorEntryId: null, anchorOffsetPx: 0, revision: 0 }),
    (error: unknown) => error instanceof AssistantSessionServiceError && error.code === 'PAGE_STATE_CONFLICT',
  );
});
