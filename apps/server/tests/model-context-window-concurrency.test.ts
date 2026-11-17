import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, ModelProfileInput, SendAssistantMessageCommand } from '@multivac/contracts';
import { AssistantSessionRuntime } from '../src/application/assistant-session-runtime.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from '../src/application/new-session-runtime-config.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import type { StoredModelSettingsState } from '../src/modules/model-settings/model-settings.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const profile: ModelProfileInput = { profileId: 'model', displayName: '窗口模型', provider: 'fixture-anthropic', modelId: 'claude-fixture',
  protocol: 'anthropic-messages', endpoint: 'https://fixture.example', contextWindow: 1_000_000, defaultThinkingLevel: 'high' };
const config: CoordinatorRuntimeConfig = { systemPrompt: '窗口并发边界', authorizedContext: [],
  model: { source: 'base', provider: 'fixture', modelId: 'base', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
const send = (commandId: string, fields: Partial<SendAssistantMessageCommand> = {}): SendAssistantMessageCommand =>
  ({ commandId, assistantSessionId: 'work', text: '核对窗口', contextRefs: [], ...fields });

async function fixture() {
  const store = new SqliteAssistantStore(':memory:');
  const adapter = new FakeCoordinatorAdapter({ seedsHistory: () => false, promptDelayMs: 0 });
  let state: StoredModelSettingsState = { revision: 0, defaultProfileId: 'model', commands: [], profiles: [profile] };
  const settings = new ModelSettingsService({ load: async () => structuredClone(state), save: async next => { state = structuredClone(next); } },
    new FakeModelSettingsCatalogFactory());
  const secondQuote = gate(), releaseQuote = gate();
  let quoteChecks = 0;
  const runtime = new AssistantSessionRuntime({ adapter, modelSettingsService: settings, eventStream: new AssistantEventStream(),
    bindingRepository: store.bindings, pageStateRepository: store.pageStates, selectionRepository: store.selections,
    commandRepository: store.commands, eventRepository: store.events,
  }, { sessionId: 'work', kind: 'work', runtimeConfig: config,
    resolveWorkingDirectory: () => ({ kind: 'session-temp', path: process.cwd() }),
    resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(settings, config),
    resolveFileQuote: async quote => {
      if (++quoteChecks === 2) { secondQuote.resolve(); await releaseQuote.promise; }
      return { sourceKind: 'file', quoteKind: quote.quoteKind, sourceFile: quote.sourceFile, text: quote.text,
        source: { sessionId: quote.sourceSessionId, title: '文件来源' } };
    },
    resolveAgentExecution: async () => {
      const model = { ...await settings.getModelProfileRuntimeConfig('model', { applyDefaultThinking: false }), thinkingLevel: 'high' as const };
      return { executor: { agentId: 'reviewer', revision: 1, name: '窗口智能体', modelProfileId: 'model', modelName: '窗口模型',
        provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel }, model, instructions: '保持本轮实际窗口。' };
    },
  });
  await runtime.initialize();
  await runtime.selection.refreshForIdle();
  const save = async (contextWindow: number | undefined, endpoint = profile.endpoint) => {
    const current = await settings.getSnapshot();
    await settings.save({ commandId: `window:${current.revision}`, revision: current.revision, profile: { ...profile, contextWindow, endpoint } });
  };
  return { runtime, adapter, settings, store, save, secondQuote, releaseQuote,
    async close() { releaseQuote.resolve(); adapter.releasePromptCompletionBarrier(); await runtime.selection.refreshForIdle(); runtime.dispose(); store.close(); } };
}

for (const target of [500_000, undefined]) test(`窗口并发：文件来源异步复核期间${target ? '保存' : '清除'}窗口，不得以旧窗口派发`, async () => {
  const f = await fixture();
  let pending: Promise<unknown> | undefined;
  try {
    const command = send('quoted', { quote: { sourceKind: 'file', quoteKind: 'source', sourceSessionId: 'work',
      sourceFile: { root: process.cwd(), path: 'fixture.bin' }, text: '' } });
    pending = f.runtime.commands.send(command).then(receipt => ({ receipt }), error => ({ error }));
    await f.secondQuote.promise;
    await f.save(target);
    f.releaseQuote.resolve();
    await pending;
    assert.equal(f.adapter.calls.filter(call => call.method === 'prompt').length, 0, '配置在受理前变化，不能沿用旧准备结果');
    await f.runtime.selection.refreshForIdle();
    assert.equal(f.store.selections.getSelection('work')?.model.contextWindow, target);
    const retried = await f.runtime.commands.send(send('retry-after-refresh'));
    assert.equal(retried.terminalOutcome, 'succeeded');
    assert.equal(f.adapter.calls.filter(call => call.method === 'prompt').length, 1);
    assert.equal((await f.runtime.selection.getOptions()).selection.thinkingLevel, 'high');
  } finally { f.releaseQuote.resolve(); await pending; await f.close(); }
});

for (const target of [500_000, undefined]) test(`窗口并发：受理后最终准入读取新版本时${target ? '保存' : '清除'}窗口，不放行旧准备结果`, async () => {
  const f = await fixture();
  const read = f.settings.getConfigurationForAccess.bind(f.settings);
  let changed = false;
  f.settings.getConfigurationForAccess = async () => {
    if (!changed && f.store.commands.get('late-window')) {
      changed = true;
      await f.save(target);
    }
    return read();
  };
  try {
    const result = await f.runtime.commands.send(send('late-window'));
    assert.equal(changed, true);
    assert.equal(result.terminalOutcome, 'rejected');
    assert.equal(f.adapter.calls.filter(call => call.method === 'prompt').length, 0);
    assert.equal(f.runtime.commands.isRunning(), false);
    await f.runtime.selection.refreshForIdle();
    assert.equal(f.store.selections.getSelection('work')?.model.contextWindow, target);
  } finally { await f.close(); }
});

for (const behavior of ['steer', 'followUp'] as const) for (const target of [500_000, undefined])
  test(`窗口并发：指定智能体运行中${target ? '保存' : '清除'}窗口，${behavior} 沿用原执行配置`, async () => {
    const f = await fixture();
    let running: ReturnType<typeof f.runtime.commands.send> | undefined;
    try {
      f.adapter.armPromptCompletionBarrier(true);
      running = f.runtime.commands.send(send('agent-running', { agentId: 'reviewer' }));
      await f.adapter.waitForPromptCompletionBarrierEntry();
      await f.save(target);
      const command = send('agent-append', { streamingBehavior: behavior });
      const queued = await f.runtime.commands.send(command);
      assert.equal(queued.terminalOutcome, 'accepted', JSON.stringify(queued));
      assert.equal(f.store.commands.get(command.commandId)?.dispatchMode, behavior);
      assert.equal(f.adapter.calls.filter(call => call.method === behavior).length, 1);
      assert.deepEqual(await f.runtime.commands.send(command), queued);
      assert.equal(f.adapter.calls.filter(call => call.method === behavior).length, 1);
      assert.equal(f.store.commands.get('agent-running')?.agentExecution?.model.contextWindow, 1_000_000);
      assert.equal(f.adapter.calls.filter(call => call.method === 'turnExecution').length, 1);
      f.adapter.releasePromptCompletionBarrier(); await running;
      await f.runtime.selection.refreshForIdle();
      const next = await f.runtime.commands.send(send('agent-next', { agentId: 'reviewer' }));
      assert.equal(next.terminalOutcome, 'succeeded');
      assert.equal(f.store.commands.get('agent-next')?.agentExecution?.model.contextWindow, target);
      assert.equal((await f.runtime.selection.getOptions()).selection.thinkingLevel, 'high');
    } finally { f.adapter.releasePromptCompletionBarrier(); await running; await f.close(); }
  });

test('窗口并发：指定智能体追加仍拒绝端点变化，不借窗口兼容绕过身份核对', async () => {
  const f = await fixture();
  let running: ReturnType<typeof f.runtime.commands.send> | undefined;
  try {
    f.adapter.armPromptCompletionBarrier(true);
    running = f.runtime.commands.send(send('endpoint-running', { agentId: 'reviewer' }));
    await f.adapter.waitForPromptCompletionBarrierEntry();
    await f.save(500_000, 'https://changed.example');
    const rejected = await f.runtime.commands.send(send('endpoint-append', { streamingBehavior: 'steer' }));
    assert.equal(rejected.terminalOutcome, 'rejected');
    assert.equal(f.adapter.calls.filter(call => call.method === 'steer').length, 0);
    assert.equal(f.adapter.calls.filter(call => call.method === 'turnExecution').length, 1);
  } finally { f.adapter.releasePromptCompletionBarrier(); await running; await f.close(); }
});
