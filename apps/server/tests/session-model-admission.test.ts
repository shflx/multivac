import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CoordinatorModelConfig, ModelProfileInput } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { ModelAccessService } from '../src/application/model-access-service.js';
import { SessionModelSelectionService } from '../src/application/session-model-selection-service.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { FakeModelAccessBackend } from '../src/runtime/executors/fake-model-access-backend.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { PiModelAccessBackend } from '../src/runtime/executors/pi-model-access-backend.js';
import { SqliteAssistantStore, SqliteAssistantBindingRepository, SqliteAssistantCommandRepository } from '../src/storage/sqlite-assistant-store.js';
import type { StoredModelSettingsState } from '../src/modules/model-settings/model-settings.js';
import type { ModelAccessState } from '../src/modules/model-settings/model-access.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const sessionId = 'global-coordinator';
const profile: ModelProfileInput = { profileId: 'gpt', displayName: 'GPT', provider: 'fixture', modelId: 'gpt-fixture',
  protocol: 'openai-responses', endpoint: 'https://fixture.example/v1' };
const missing: ModelProfileInput = { ...profile, profileId: 'missing', provider: 'missing-auth' };

class DelayedAdapter extends FakeCoordinatorAdapter {
  nativeChecks = 0;
  nativeGate: { nth: number; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  setterGate: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  override async validateModelSelection(id: string) {
    const result = await super.validateModelSelection(id);
    const pending = this.nativeGate;
    if (++this.nativeChecks === pending?.nth) { pending.entered.resolve(); await pending.release.promise; }
    return result;
  }
  override async setModel(id: string, model: CoordinatorModelConfig, assertCurrent?: () => void) {
    const pending = this.setterGate;
    if (pending) { pending.entered.resolve(); await pending.release.promise; }
    return super.setModel(id, model, assertCurrent);
  }
}

async function harness() {
  const backend = new FakeModelAccessBackend();
  const adapter = new DelayedAdapter();
  const store = new SqliteAssistantStore(':memory:');
  let state: StoredModelSettingsState = { revision: 0, defaultProfileId: null, commands: [], profiles: [profile, missing] };
  let accessState: ModelAccessState = { version: 1, credentialRevision: 0, accessRevision: 0, commands: [], checks: [] };
  let inspectGate: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const delegate = new FakeModelSettingsCatalogFactory((provider) => backend.authenticated(provider));
  const settings = new ModelSettingsService({ load: async () => state, save: async (next) => { state = structuredClone(next); } }, {
    create: async (profiles, options) => {
      const catalog = await delegate.create(profiles);
      return { inspect: async (items) => {
        const result = await catalog.inspect(items);
        const pending = inspectGate;
        if (pending) { inspectGate = undefined; pending.entered.resolve(); await pending.release.promise; }
        return result;
      } };
    },
  });
  const access = new ModelAccessService({ settings, backend,
    store: { load: async () => structuredClone(accessState), save: async (next) => { accessState = structuredClone(next); } } });
  const events = new AssistantEventStream();
  const lock = new AssistantOperationLock();
  const session = new AssistantSessionService({ adapter, bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: store, selectionRepository: store, runtimeConfig: {
      systemPrompt: 'Multivac', authorizedContext: [], model: { source: 'base', provider: 'fixture', modelId: 'base', thinkingLevel: 'off' },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
    } });
  const commands: AssistantTurnCommandService = new AssistantTurnCommandService({ adapter, sessionService: session,
    commandRepository: new SqliteAssistantCommandRepository(store), eventStream: events, operationLock: lock,
    validateSelectionForSend: () => selection.validateForSend(),
    withSelectionForSend: (dispatch) => selection.withSelectionForSend(dispatch) });
  const selection: SessionModelSelectionService = new SessionModelSelectionService({ adapter, sessionService: session,
    repository: store, settings, access, lock, isRunning: () => commands.isRunning() });
  await settings.initialize(); await session.initialize();
  return { adapter, backend, settings, access, selection, commands, events, store,
    armInspect: () => { const pending = { entered: gate(), release: gate() }; inspectGate = pending; return pending; },
    select: async (id = 'gpt') => selection.setModel({ commandId: `select-${id}`, sessionId, profileId: id,
      revision: store.getSelection(sessionId)!.revision }),
    send: (commandId: string) => commands.send({ commandId, assistantSessionId: sessionId, text: 'must not reach stale endpoint', contextRefs: [] }),
    close: async () => { await access.close(); adapter.dispose(); store.close(); } };
}

for (const field of ['modelId', 'endpoint'] as const) test(`delayed inspect 期间 ${field} 更新：send=0 且保留实际 Pi 引用`, async () => {
  const h = await harness(); const pending = h.armInspect();
  try {
    pending.release.resolve(); await h.select();
    const delayed = h.armInspect();
    const sent = h.send(`stale-${field}`);
    const rejected = assert.rejects(sent);
    await delayed.entered.promise;
    await h.settings.save({ commandId: `change-${field}`, revision: 0,
      profile: { ...profile, [field]: field === 'modelId' ? 'new-model' : 'https://new.example/v1' } });
    delayed.release.resolve(); await rejected;
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    assert.equal(h.store.getSelection(sessionId)?.model.modelId, 'gpt-fixture');
  } finally { pending.release.resolve(); await h.close(); }
});

test('delayed target inspect 期间 profile 更新：旧 target 不调用 Pi setter', async () => {
  const h = await harness(); const pending = h.armInspect();
  try {
    const changed = h.select(); await pending.entered.promise;
    await h.settings.save({ commandId: 'target-changed', revision: 0,
      profile: { ...profile, modelId: 'target-new', endpoint: 'https://target-new.example/v1' } });
    pending.release.resolve(); const result = await changed;
    assert.equal(result.status, 'failed');
    assert.equal(h.adapter.calls.some((call) => call.method === 'setModel'), false);
  } finally { pending.release.resolve(); await h.close(); }
});

test('delayed inspect 期间 auth 版本变化：send=0，不采用旧 available=true', async () => {
  const h = await harness();
  try {
    await h.backend.configure(missing); await h.select('missing');
    const delayed = h.armInspect(); const rejected = assert.rejects(h.send('stale-auth'));
    await delayed.entered.promise;
    await h.backend.revoke(missing); delayed.release.resolve(); await rejected;
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    assert.equal((await h.selection.getOptions()).selection.availability.available, false);
  } finally { await h.close(); }
});

test('base auth 在异步 Pi check 中变化也拒绝 send，不依赖 profileId', async () => {
  const h = await harness(); const pending = { nth: 1, entered: gate(), release: gate() };
  try {
    h.adapter.nativeChecks = 0; h.adapter.nativeGate = pending;
    const rejected = assert.rejects(h.send('base-auth-change'));
    await pending.entered.promise; await h.backend.configure(profile); pending.release.resolve(); await rejected;
    assert.equal(h.store.getSelection(sessionId)?.model.profileId, undefined);
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
  } finally { pending.release.resolve(); await h.close(); }
});

test('accepted 后最终 handoff check 中 auth 改变：send=0、回执终态、不遗留运行占用', async () => {
  const h = await harness(); const pending = { nth: 3, entered: gate(), release: gate() };
  try {
    await h.select(); h.adapter.nativeChecks = 0; h.adapter.nativeGate = pending;
    const sent = h.send('late-auth');
    await pending.entered.promise; await h.backend.configure(profile); pending.release.resolve();
    const receipt = await sent;
    assert.equal(receipt.status, 'terminal'); assert.equal(receipt.terminalOutcome, 'rejected');
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    assert.equal(h.commands.isRunning(), false);
  } finally { pending.release.resolve(); await h.close(); }
});

for (const behavior of ['steer', 'followUp'] as const) test(`${behavior} 最终认证 gate 期间原 Turn settled：不入队、不改派、失败回执幂等`, async () => {
  const h = await harness();
  const pending = { nth: 3, entered: gate(), release: gate() };
  const command = { commandId: `settled-${behavior}`, assistantSessionId: sessionId,
    text: 'must not leak into a later turn', contextRefs: [], streamingBehavior: behavior };
  let original: ReturnType<typeof h.send> | undefined;
  let queued: ReturnType<typeof h.send> | undefined;
  try {
    await h.select();
    h.adapter.armPromptCompletionBarrier(true);
    original = h.send(`original-${behavior}`);
    await h.adapter.waitForPromptCompletionBarrierEntry();
    h.adapter.nativeChecks = 0; h.adapter.nativeGate = pending;
    queued = h.commands.send(command);
    await pending.entered.promise;
    assert.deepEqual(h.adapter.isStreaming(sessionId), { ok: true, value: true });
    assert.equal(h.commands.currentPromptCommandId(), `original-${behavior}`);

    h.adapter.releasePromptCompletionBarrier();
    assert.equal((await original).terminalOutcome, 'succeeded');
    assert.deepEqual(h.adapter.isStreaming(sessionId), { ok: true, value: false });
    assert.equal(h.commands.currentPromptCommandId(), null);
    pending.release.resolve();
    const receipt = await queued;
    assert.equal(receipt.status, 'terminal');
    assert.equal(receipt.terminalOutcome, 'failed');
    assert.equal(receipt.error?.code, 'COMMAND_STATE_MISMATCH');
    assert.equal(h.adapter.calls.filter((call) => call.method === 'steer' || call.method === 'followUp').length, 0);
    assert.equal(h.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
    assert.equal(h.commands.isRunning(), false);

    const checks = h.adapter.nativeChecks;
    assert.deepEqual(await h.commands.send(command), receipt);
    assert.deepEqual(h.commands.get(command.commandId).receipt, receipt);
    assert.equal(h.adapter.nativeChecks, checks);
    assert.equal(h.adapter.calls.filter((call) => call.method === 'steer' || call.method === 'followUp').length, 0);
    assert.equal(h.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
  } finally {
    pending.release.resolve(); h.adapter.releasePromptCompletionBarrier();
    await Promise.allSettled([original, queued].filter((promise) => promise !== undefined));
    await h.close();
  }
});

test('认证 backend 没有同步版本复核能力时安全拒绝 handoff，不用缓存版本放行', async () => {
  const h = await harness();
  try {
    await h.select();
    Object.defineProperty(h.backend, 'credentialVersionNow', { value: undefined });
    const receipt = await h.send('async-only-backend');
    assert.equal(receipt.terminalOutcome, 'rejected');
    assert.equal(h.adapter.calls.some((call) => call.method === 'prompt'), false);
    assert.equal(h.commands.isRunning(), false);
  } finally { await h.close(); }
});

test('Pi prepare 等待后 setter 前认证版本复核，旧 target 不应用', async () => {
  const h = await harness(); const pending = { entered: gate(), release: gate() };
  try {
    h.adapter.setterGate = pending;
    const changed = h.select();
    await pending.entered.promise; await h.backend.configure(profile); pending.release.resolve();
    assert.equal((await changed).status, 'failed');
    assert.equal(h.adapter.calls.some((call) => call.method === 'setModel'), false);
    assert.equal(h.store.getSelection(sessionId)?.model.profileId, undefined);
  } finally { pending.release.resolve(); await h.close(); }
});

test('GET 在 selection inspect 中配置更新后重新只读检查，不混合 selection/options 版本', async () => {
  const h = await harness();
  try {
    await h.select(); const pending = h.armInspect();
    const read = h.selection.getOptions(); await pending.entered.promise;
    await h.settings.save({ commandId: 'get-new-profile', revision: 0,
      profile: { ...profile, displayName: 'New GPT', modelId: 'new-model', endpoint: 'https://new.example/v1' } });
    pending.release.resolve(); const result = await read;
    assert.equal(result.selection.modelId, 'gpt-fixture'); assert.equal(result.selection.availability.available, false);
    assert.equal(result.options.find((item) => item.profileId === 'gpt')?.modelId, 'new-model');
    assert.equal(result.options.find((item) => item.profileId === 'gpt')?.displayName, 'New GPT');
    assert.equal(h.adapter.calls.filter((call) => call.method === 'setModel').length, 1);
  } finally { await h.close(); }
});

test('GET 在 inspect 中认证撤销后只返回一致的不可用 selection/options', async () => {
  const h = await harness();
  try {
    await h.backend.configure(missing); await h.select('missing');
    const pending = h.armInspect(); const read = h.selection.getOptions(); await pending.entered.promise;
    await h.backend.revoke(missing); pending.release.resolve(); const result = await read;
    assert.equal(result.selection.availability.available, false);
    assert.equal(result.options.find((item) => item.profileId === 'missing')?.availability.available, false);
  } finally { await h.close(); }
});

test('离线真实 SDK base 模型异步校验后 auth.json 撤销：版本复核拒绝 handoff=0，不存凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-base-admission-'));
  const agentDir = join(root, 'agent'); const cwd = join(root, 'workspace'); const sessionDir = join(root, 'sessions');
  await mkdir(agentDir); await mkdir(cwd);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-base-admission-key' } }), { mode: 0o600 });
  const entered = gate(); const release = gate();
  class SDKAdapter extends PiCoordinatorAdapter {
    armed = false;
    override async validateModelSelection(id: string) {
      const result = await super.validateModelSelection(id);
      if (this.armed) { this.armed = false; entered.resolve(); await release.promise; }
      return result;
    }
  }
  const adapter = new SDKAdapter({ cwd, agentDir, sessionDir,
    sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, modelsPath: null }) });
  const store = new SqliteAssistantStore(':memory:');
  let accessState: ModelAccessState = { version: 1, credentialRevision: 0, accessRevision: 0, commands: [], checks: [] };
  const settings = new ModelSettingsService({ load: async () => ({ revision: 0, profiles: [], defaultProfileId: null, commands: [] }), save: async () => {} },
    new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }));
  const access = new ModelAccessService({ settings, backend: new PiModelAccessBackend({ authPath }),
    store: { load: async () => accessState, save: async (next) => { accessState = structuredClone(next); } } });
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
    const plain = runtime.getModels('openai').find((model) => model.api === 'openai-responses' && !model.reasoning)!;
    assert.ok(plain);
    const session = new AssistantSessionService({ adapter, bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: store, selectionRepository: store, runtimeConfig: {
        systemPrompt: 'Multivac', authorizedContext: [], model: { source: 'base', provider: plain.provider, modelId: plain.id, thinkingLevel: 'off' },
        retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
      } });
    await settings.initialize(); await session.initialize();
    const selection = new SessionModelSelectionService({ adapter, sessionService: session, repository: store,
      settings, access, lock: new AssistantOperationLock(), isRunning: () => false });
    adapter.armed = true; let dispatches = 0;
    const rejected = assert.rejects(selection.withSelectionForSend(() => { dispatches++; }));
    await entered.promise; await writeFile(authPath, '{}'); release.resolve(); await rejected;
    assert.equal(dispatches, 0); assert.equal(store.getSelection(sessionId)?.model.profileId, undefined);
    const options = await selection.getOptions();
    assert.equal(options.selection.availability.available, false);
    assert.equal(JSON.stringify(store.getSelection(sessionId)).includes('synthetic-base-admission-key'), false);
  } finally { release.resolve(); await access.close(); adapter.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
