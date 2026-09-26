import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorModelConfig, CoordinatorRuntimeConfig, CoordinatorResult, CoordinatorModelUpdate } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { SessionModelSelectionService } from '../src/application/session-model-selection-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from '../src/application/new-session-runtime-config.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore, SqliteAssistantBindingRepository, SqliteAssistantCommandRepository } from '../src/storage/sqlite-assistant-store.js';
import type { StoredModelSettingsState } from '../src/modules/model-settings/model-settings.js';

const id = 'global-coordinator';
const config: CoordinatorRuntimeConfig = {
  systemPrompt: 'Multivac', authorizedContext: [], model: { provider: 'base', modelId: 'base-model', thinkingLevel: 'off', source: 'base' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
};
const initial: StoredModelSettingsState = { revision: 0, defaultProfileId: null, commands: [], profiles: [
  { profileId: 'claude', displayName: 'Claude', provider: 'fixture-anthropic', modelId: 'claude-fixture', protocol: 'anthropic-messages', endpoint: 'https://anthropic.fixture.example' },
  { profileId: 'gpt', displayName: 'GPT', provider: 'fixture', modelId: 'gpt-fixture', protocol: 'openai-responses', endpoint: 'https://fixture.example/v1' },
  { profileId: 'missing', displayName: 'Missing', provider: 'missing-auth', modelId: 'missing-model', protocol: 'openai-responses', endpoint: 'https://missing.example/v1' },
] };

function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function harness(adapter = new FakeCoordinatorAdapter(), defaultProfileId: string | null = null) {
  const store = new SqliteAssistantStore(':memory:');
  let state = structuredClone(initial);
  state.defaultProfileId = defaultProfileId;
  let authenticated = true;
  const settings = new ModelSettingsService({ load: async () => state, save: async (next) => { state = structuredClone(next); } },
    new FakeModelSettingsCatalogFactory((provider) => provider !== 'missing-auth' && authenticated));
  const sessionService = new AssistantSessionService({ adapter, bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: store, runtimeConfig: config, selectionRepository: store,
    resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(settings, config) });
  const lock = new AssistantOperationLock();
  const commands: AssistantTurnCommandService = new AssistantTurnCommandService({ sessionService, adapter,
    commandRepository: new SqliteAssistantCommandRepository(store), eventStream: new AssistantEventStream(), operationLock: lock,
    validateSelectionForSend: () => selection.validateForSend() });
  const selection: SessionModelSelectionService = new SessionModelSelectionService({ sessionService, adapter, repository: store, settings, lock,
    isRunning: () => commands.isRunning() });
  await sessionService.initialize();
  return { adapter, store, settings, selection, commands, auth: (value: boolean) => { authenticated = value; },
    close: () => { adapter.dispose(); store.close(); } };
}
const model = (commandId: string, revision: number, profileId = 'claude') => ({ commandId, revision, sessionId: id as 'global-coordinator', profileId });
const send = (commandId: string) => ({ commandId, assistantSessionId: id, text: 'hello', contextRefs: [] });

test('基础来源、可用等级、切 model 归一化、revision、幂等和只读不触发 setter', async () => {
  const h = await harness();
  try {
    const base = await h.selection.getOptions();
    assert.equal(base.selection.profileId, null); assert.equal(base.selection.source, 'base');
    const first = await h.selection.setModel(model('select-1', 0));
    assert.equal(first.status, 'succeeded'); assert.equal(first.selection.revision, 1);
    assert.equal((await h.selection.setModel({ revision: 0, profileId: 'claude', sessionId: id, commandId: 'select-1' })).replayed, true);
    assert.deepEqual(first.selection.availableThinkingLevels, ['off', 'minimal', 'low', 'medium', 'high']);
    assert.equal((await h.selection.setThinkingLevel({ commandId: 'think-1', sessionId: id, revision: 1, thinkingLevel: 'high' })).selection.thinkingLevel, 'high');
    assert.equal((await h.selection.setThinkingLevel({ commandId: 'invalid-level', sessionId: id, revision: 2, thinkingLevel: 'max' })).error, 'THINKING_LEVEL_UNAVAILABLE');
    const normalized = await h.selection.setModel(model('select-2', 2, 'gpt'));
    assert.equal(normalized.selection.thinkingLevel, 'off'); assert.deepEqual(normalized.selection.availableThinkingLevels, ['off']);
    assert.equal((await h.selection.setModel(model('select-2', 2, 'gpt'))).replayed, true);
    assert.equal((await h.selection.setModel(model('select-2', 2, 'claude'))).error, 'COMMAND_ID_CONFLICT');
    assert.equal((await h.selection.setModel(model('stale', 0))).error, 'SELECTION_REVISION_CONFLICT');
    for (let n = 0; n < 3; n++) await h.selection.getOptions();
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 2);
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setThinkingLevel').length, 1);
    assert.equal(h.store.getBinding(id)?.modelProfileId, 'gpt');
  } finally { h.close(); }
});

test('真正新 session 继承全局默认；默认变更与重新打开不覆盖既有选择', async () => {
  const h = await harness(new FakeCoordinatorAdapter(), 'claude');
  try {
    const first = await h.selection.getOptions();
    assert.equal(first.selection.profileId, 'claude');
    const settings = await h.settings.getSnapshot();
    await h.settings.setDefault({ commandId: 'new-default', revision: settings.revision, profileId: 'gpt' });
    assert.equal((await h.selection.getOptions()).selection.profileId, 'claude');
    const restored = new AssistantSessionService({ adapter: h.adapter, bindingRepository: new SqliteAssistantBindingRepository(h.store),
      pageStateRepository: h.store, selectionRepository: h.store, runtimeConfig: config,
      resolveNewSessionRuntimeConfig: async () => { throw new Error('不得套用新默认'); } });
    await restored.initialize();
    assert.equal(h.adapter.readModelSelection(id).ok && h.store.getSelection(id)?.model.profileId, 'claude');
  } finally { h.close(); }
});

test('Pi 返回端点尾部斜杠与系统归一化 URL 等价，不虚报恢复或配置失效', async () => {
  class EndpointAdapter extends FakeCoordinatorAdapter {
    override setModel(sessionId: string, target: CoordinatorModelConfig) {
      return super.setModel(sessionId, { ...target, resolvedEndpoint: `${target.resolvedEndpoint}/` });
    }
  }
  const h = await harness(new EndpointAdapter());
  try {
    const result = await h.selection.setModel(model('endpoint-equivalent', 0));
    assert.equal(result.status, 'succeeded'); assert.equal(result.selection.availability.available, true);
    await h.commands.send(send('endpoint-send'));
    assert.equal(h.store.getSelection(id)?.pending, null);
  } finally { h.close(); }
});

test('runtime 缺失保持引用与不可用响应，命令不派发到 Pi', async () => {
  const h = await harness();
  try {
    await h.selection.setModel(model('valid', 0));
    h.adapter.disposeSession(id);
    // 已成功初始化的 service 不重建已丢失 runtime；只读接口如实报告恢复不可用。
    const unavailable = await h.selection.getOptions();
    assert.equal(unavailable.selection.profileId, 'claude');
    assert.equal(unavailable.selection.availability.available, false);
    assert.deepEqual(unavailable.selection.availableThinkingLevels, []);
    const result = await h.selection.setModel(model('inactive', 1, 'gpt'));
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'SELECTION_RECOVERY_UNAVAILABLE');
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 1);
  } finally { h.close(); }
});

test('runtime 模型相同但 Pi 身份不同仍禁 send 和切换，不能把模型相等当成会话对账', async () => {
  class IdentityAdapter extends FakeCoordinatorAdapter {
    mismatch = false;
    override readModelSelection(sessionId: string) {
      const result = super.readModelSelection(sessionId);
      if (result.ok && this.mismatch) result.value.piSessionId = 'another-pi-session';
      return result;
    }
  }
  const adapter = new IdentityAdapter(); const h = await harness(adapter);
  try {
    await h.selection.setModel(model('identity-initial', 0)); adapter.mismatch = true;
    assert.equal((await h.selection.getOptions()).selection.availability.available, false);
    await assert.rejects(h.commands.send(send('identity-send')));
    const rejected = await h.selection.setModel(model('identity-change', 1, 'gpt'));
    assert.equal(rejected.error, 'SELECTION_RECOVERY_UNAVAILABLE');
    assert.equal(adapter.calls.filter((call) => call.method === 'setModel').length, 1);
    assert.equal(adapter.calls.some((call) => call.method === 'prompt'), false);
  } finally { h.close(); }
});

test('失效 profile 保留引用且禁 send，不可用目标不调用 setter；同 ID 配置变化不伪造 Pi metadata', async () => {
  const h = await harness();
  try {
    assert.equal((await h.selection.setModel(model('missing', 0, 'missing'))).status, 'failed');
    await h.selection.setModel(model('claude', 0));
    h.auth(false);
    const invalid = await h.selection.getOptions();
    assert.equal(invalid.selection.profileId, 'claude'); assert.equal(invalid.selection.availability.available, false);
    await assert.rejects(h.commands.send(send('invalid-send')));
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    h.auth(true);
    const current = await h.settings.getSnapshot();
    await h.settings.save({ commandId: 'change-profile', revision: current.revision,
      profile: { ...initial.profiles[0]!, modelId: 'changed-fixture' } });
    const changed = await h.selection.getOptions();
    assert.equal(changed.selection.modelId, 'claude-fixture'); assert.equal(changed.selection.availability.reason, 'PROFILE_CONFIGURATION_CHANGED');
    await assert.rejects(h.commands.send(send('changed-send')));
    assert.equal((await h.selection.setModel(model('explicit', 1))).selection.modelId, 'changed-fixture');
  } finally { h.close(); }
});

test('prompt pre-stream/handoff 至 settled 包含 retry/compaction 始终禁切换；accepted 命令也占用', async () => {
  const before = gate(); const completion = gate();
  const h = await harness(new FakeCoordinatorAdapter({ promptBarrier: before.promise, promptCompletionBarrier: completion.promise, promptScenario: 'retryAndCompaction' }));
  let run: ReturnType<AssistantTurnCommandService['send']> | undefined;
  try {
    run = h.commands.send(send('running'));
    while (!h.adapter.calls.some((call) => call.method === 'prompt')) await new Promise((done) => setTimeout(done, 1));
    assert.deepEqual(h.adapter.isStreaming(id), { ok: true, value: false });
    assert.equal((await h.selection.setModel(model('prestream', 0))).error, 'SESSION_RUNNING');
    before.resolve();
    await new Promise((done) => setTimeout(done, 1));
    assert.equal((await h.selection.setModel(model('during', 0))).error, 'SESSION_RUNNING');
    completion.resolve(); await run;
    assert.equal((await h.selection.setModel(model('after', 0))).status, 'succeeded');
    h.store.createAccepted({ commandId: 'accepted', assistantSessionId: id, kind: 'send', payloadFingerprint: 'test', piSessionId: 'pi-fake-global-coordinator' });
    assert.equal((await h.selection.setModel(model('accepted-change', 1, 'gpt'))).error, 'SESSION_RUNNING');
  } finally { before.resolve(); completion.resolve(); await run; h.close(); }
});

test('选模先持锁，send 不能并发绕过 setter；send 使用完成后的真实选择', async () => {
  const entered = gate(); const release = gate();
  class SlowAdapter extends FakeCoordinatorAdapter {
    override async setModel(sessionId: string, target: CoordinatorModelConfig) {
      entered.resolve(); await release.promise; return super.setModel(sessionId, target);
    }
  }
  const h = await harness(new SlowAdapter());
  try {
    const change = h.selection.setModel(model('slow', 0)); await entered.promise;
    const run = h.commands.send(send('after-slow'));
    await new Promise((done) => setTimeout(done, 2));
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    release.resolve(); assert.equal((await change).status, 'succeeded'); await run;
    assert.equal((await h.selection.getOptions()).selection.profileId, 'claude');
  } finally { release.resolve(); h.close(); }
});

for (const partial of [false, true]) test(`Pi setter ${partial ? '部分成功' : '未成功'}后抛错返回实际选择；重放不调用 setter`, async () => {
  class ThrowAdapter extends FakeCoordinatorAdapter {
    count = 0;
    override async setModel(sessionId: string, target: CoordinatorModelConfig): Promise<CoordinatorResult<CoordinatorModelUpdate>> {
      this.count++; if (partial) await super.setModel(sessionId, target); throw new Error('injected');
    }
  }
  const adapter = new ThrowAdapter(); const h = await harness(adapter);
  try {
    const result = await h.selection.setModel(model('throw', 0));
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'PI_SELECTION_FAILED');
    assert.equal(result.selection.profileId, partial ? 'claude' : null);
    assert.equal(result.selection.provider, partial ? 'fixture-anthropic' : 'base');
    assert.equal((await h.selection.setModel(model('throw', 0))).status, 'failed');
    assert.equal(adapter.count, 1);
  } finally { h.close(); }
});

test('意图保存失败不调用 Pi；完成保存失败返回 unknown，重复命令只对账不重发', async () => {
  const h = await harness();
  try {
    const begin = h.store.beginSelection.bind(h.store);
    h.store.beginSelection = () => { throw new Error('intent storage'); };
    const rejected = await h.selection.setModel(model('intent', 0));
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.error, 'SELECTION_STORAGE_FAILED');
    assert.equal(rejected.selection.revision, 0);
    assert.equal(h.adapter.calls.some((call) => call.method === 'setModel'), false);
    h.store.beginSelection = begin;
    const finish = h.store.finishSelection.bind(h.store);
    h.store.finishSelection = () => { throw new Error('finish storage'); };
    const result = await h.selection.setModel(model('finish', 0));
    assert.equal(result.status, 'unknown'); assert.equal(result.selection.availability.available, false);
    assert.equal(result.selection.modelId, 'claude-fixture');
    h.store.finishSelection = finish;
    assert.equal((await h.selection.setModel(model('finish', 0))).error, 'SELECTION_INTERRUPTED');
    assert.equal((await h.selection.getOptions()).selection.profileId, 'claude');
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 1);
  } finally { h.close(); }
});

test('意图已提交但存储返回异常时只对账原命令，绝不开始 Pi setter', async () => {
  const h = await harness();
  try {
    const begin = h.store.beginSelection.bind(h.store);
    h.store.beginSelection = (selection, command) => { begin(selection, command); throw new Error('after commit'); };
    const result = await h.selection.setModel(model('committed-intent', 0));
    assert.equal(result.status, 'unknown'); assert.equal(result.selection.availability.available, false);
    assert.equal(h.adapter.calls.some((call) => call.method === 'setModel'), false);
    h.store.beginSelection = begin;
    const replay = await h.selection.setModel(model('committed-intent', 0));
    assert.equal(replay.status, 'failed'); assert.equal(replay.error, 'SELECTION_INTERRUPTED');
    assert.equal(replay.selection.profileId, null);
    assert.equal(h.adapter.calls.some((call) => call.method === 'setModel'), false);
  } finally { h.close(); }
});

test('Pi live 改变而 transcript 未确认时不报 success，read 不回退也不重发，send 禁止', async () => {
  class NonDurableAdapter extends FakeCoordinatorAdapter {
    durable = true;
    override readModelSelection(sessionId: string) {
      const result = super.readModelSelection(sessionId);
      if (result.ok) result.value.durable = this.durable;
      return result;
    }
    override async setModel(sessionId: string, target: CoordinatorModelConfig) {
      const result = await super.setModel(sessionId, target); this.durable = false; return result;
    }
  }
  const h = await harness(new NonDurableAdapter());
  try {
    const result = await h.selection.setModel(model('nondurable', 0));
    assert.equal(result.status, 'failed'); assert.equal(result.selection.modelId, 'claude-fixture');
    assert.equal((await h.selection.getOptions()).selection.modelId, 'claude-fixture');
    await assert.rejects(h.commands.send(send('not-durable')));
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 1);
  } finally { h.close(); }
});

test('模型配置改了手动推理能力：已打开会话仍可用，下次发送或调整等级时自动换用，不需要重新选模', async () => {
  const h = await harness();
  try {
    const selected = await h.selection.setModel(model('select-gpt', 0, 'gpt'));
    assert.deepEqual(selected.selection.availableThinkingLevels, ['off']);
    const gpt = initial.profiles.find((profile) => profile.profileId === 'gpt')!;
    const saved = await h.settings.getSnapshot();
    await h.settings.save({ commandId: 'gpt-reasoning', revision: saved.revision, profile: { ...gpt, reasoning: 'enabled' } });
    assert.equal((await h.settings.getSnapshot()).profiles.find((profile) => profile.profileId === 'gpt')?.reasoning, 'enabled');

    // 只读不换用：仍可发送，推理等级先按开启推理预告。
    const pending = await h.selection.getOptions();
    assert.equal(pending.selection.availability.available, true);
    assert.deepEqual(pending.selection.availableThinkingLevels, ['off', 'minimal', 'low', 'medium', 'high']);
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 1);

    // 调整推理等级时先换用新配置，客户端沿用换用前的 revision。
    const thinking = await h.selection.setThinkingLevel({ commandId: 'think-after-enable', sessionId: id,
      revision: pending.selection.revision, thinkingLevel: 'high' });
    assert.equal(thinking.status, 'succeeded');
    assert.equal(thinking.selection.thinkingLevel, 'high');
    assert.equal(h.store.getSelection(id)?.model.reasoning, true);

    // 关闭推理后，下次发送前自动换用，推理等级归为 off。
    const current = await h.settings.getSnapshot();
    await h.settings.save({ commandId: 'gpt-reasoning-off', revision: current.revision, profile: { ...gpt, reasoning: 'disabled' } });
    assert.deepEqual((await h.selection.getOptions()).selection.availableThinkingLevels, ['off']);
    await h.commands.send(send('send-after-disable'));
    assert.equal(h.store.getSelection(id)?.model.reasoning, false);
    assert.equal((await h.selection.getOptions()).selection.thinkingLevel, 'off');
    assert.equal(h.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
  } finally { h.close(); }
});
