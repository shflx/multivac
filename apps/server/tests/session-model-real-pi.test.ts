import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ModelRuntime, SessionManager, buildSessionContext, createAgentSession } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig, CoordinatorThinkingLevel } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionModelSelectionService } from '../src/application/session-model-selection-service.js';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory, ensurePersistedSessionManager } from '../src/runtime/executors/pi-session-factory.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { FileModelSelectionRecoveryRepository } from '../src/storage/file-model-selection-recovery-store.js';
import { SqliteAssistantStore, SqliteAssistantBindingRepository } from '../src/storage/sqlite-assistant-store.js';

for (const scenario of ['success', 'model-intent', 'thinking-intent', 'bindingless', 'pi-partial', 'endpoint-ambiguity', 'legacy-base', 'missing-session'] as const) test(`离线真实 Pi setter/transcript/reopen ${scenario} 保持模型等级与引用一致或安全关闭`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-selection-sdk-'));
  const agentDir = join(root, 'agent'); const cwd = join(root, 'workspace'); const sessionDir = join(root, 'sessions');
  await mkdir(agentDir); await mkdir(cwd);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'offline-sdk-selection-secret' } }), { mode: 0o600 });
  let store = new SqliteAssistantStore(join(root, 'database.sqlite'));
  const adapters: PiCoordinatorAdapter[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
    const models = runtime.getModels('openai').filter((model) => model.api === 'openai-responses');
    const reasoning = models.find((model) => model.reasoning)!;
    const plain = models.find((model) => !model.reasoning)!;
    assert.ok(reasoning); assert.ok(plain);
    const config: CoordinatorRuntimeConfig = {
      systemPrompt: 'Multivac', authorizedContext: [], model: { provider: plain.provider, modelId: plain.id, source: 'base', thinkingLevel: 'off' },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
    };
    const settings = new ModelSettingsService({ load: async () => ({ revision: 0, defaultProfileId: null, commands: [], profiles: [{
      profileId: 'reasoning', displayName: 'Reasoning', provider: reasoning.provider, modelId: reasoning.id, protocol: 'openai-responses', endpoint: null,
    }] }), save: async () => {} }, new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }));
    let defaultCalls = 0;
    let setterCalls = 0;
    const make = () => {
      const adapter = new PiCoordinatorAdapter({ agentDir, cwd, sessionDir,
        sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, modelsPath: null,
          createAgentSession: async (options) => {
            const result = await createAgentSession(options);
            const set = result.session.setModel.bind(result.session);
            result.session.setModel = async (model, options) => {
              setterCalls++; await set(model, options);
              if (scenario === 'pi-partial' && setterCalls === 1) throw new Error('injected after actual Pi setter');
            };
            return result;
          },
        }) });
      adapters.push(adapter);
      const session = new AssistantSessionService({ adapter, bindingRepository: new SqliteAssistantBindingRepository(store), pageStateRepository: store,
        selectionRepository: store, runtimeConfig: config, modelSelectionRecoveryRepository: new FileModelSelectionRecoveryRepository(join(root, 'recovery')),
        resolveNewSessionRuntimeConfig: async () => { defaultCalls++; return config; } });
      const selection = new SessionModelSelectionService({ adapter, sessionService: session, repository: store, settings,
        lock: new AssistantOperationLock(), isRunning: () => false });
      return { adapter, session, selection };
    };
    const first = make(); const binding = await first.session.initialize();
    assert.equal(defaultCalls, 1);
    if (scenario === 'legacy-base') {
      const changed = await first.adapter.setModel('global-coordinator', {
        source: 'base', provider: reasoning.provider, modelId: reasoning.id, thinkingLevel: 'high',
      });
      assert.equal(changed.ok, true);
      const level = first.adapter.readModelSelection('global-coordinator'); assert.equal(level.ok, true);
      first.adapter.dispose(); store.close();
      const legacy = new DatabaseSync(join(root, 'database.sqlite'));
      legacy.exec(`DELETE FROM assistant_model_selection;
        UPDATE assistant_session_binding SET model_provider = NULL, model_id = NULL,
          model_protocol = NULL, model_endpoint = NULL, model_resolved_endpoint = NULL,
          model_source = NULL, model_profile_id = NULL, model_endpoint_mode = NULL;`);
      legacy.close(); store = new SqliteAssistantStore(join(root, 'database.sqlite'));
      const restored = make(); await restored.session.initialize();
      const selection = await restored.selection.getOptions();
      assert.equal(selection.selection.source, 'base'); assert.equal(selection.selection.profileId, null);
      assert.equal(selection.selection.modelId, reasoning.id);
      assert.equal(selection.selection.thinkingLevel, level.ok ? level.value.model.thinkingLevel : 'off');
      assert.equal(selection.selection.availability.available, true);
      assert.equal(defaultCalls, 1); assert.equal(setterCalls, 1);
      return;
    }
    if (scenario === 'model-intent') store.finishSelection = () => { throw new Error('injected model storage crash'); };
    const switched = await first.selection.setModel({ commandId: 'sdk-model', sessionId: 'global-coordinator', profileId: 'reasoning', revision: 0 });
    assert.equal(switched.status, scenario === 'model-intent' ? 'unknown' : scenario === 'pi-partial' ? 'failed' : 'succeeded', JSON.stringify(switched));
    const levels = switched.selection.availableThinkingLevels;
    const level = scenario === 'model-intent' ? switched.selection.thinkingLevel
      : levels.find((candidate) => candidate !== 'off' && candidate !== switched.selection.thinkingLevel) as CoordinatorThinkingLevel;
    assert.ok(level);
    if (scenario === 'thinking-intent') store.finishSelection = () => { throw new Error('injected storage crash'); };
    if (scenario !== 'model-intent') {
      const thought = await first.selection.setThinkingLevel({ commandId: 'sdk-thinking', sessionId: 'global-coordinator', thinkingLevel: level, revision: 1 });
      assert.equal(thought.status, scenario === 'thinking-intent' ? 'unknown' : 'succeeded');
    }
    if (scenario === 'endpoint-ambiguity') {
      const snapshot = await settings.getSnapshot();
      await settings.save({ commandId: 'change-endpoint', revision: snapshot.revision, profile: {
        profileId: 'reasoning', displayName: 'Reasoning', provider: reasoning.provider, modelId: reasoning.id,
        protocol: 'openai-responses', endpoint: 'https://new-endpoint.example/v1',
      } });
      const before = await first.selection.getOptions();
      assert.equal(before.selection.modelId, reasoning.id);
      assert.equal(before.selection.availability.available, false);
      store.finishSelection = () => { throw new Error('injected same-id endpoint storage crash'); };
      const changed = await first.selection.setModel({ commandId: 'same-id-endpoint', sessionId: 'global-coordinator', profileId: 'reasoning', revision: before.selection.revision });
      assert.equal(changed.status, 'unknown');
      const entries = SessionManager.open(binding.piSessionPath, sessionDir, cwd).getBranch().length;
      first.adapter.dispose(); store.close(); store = new SqliteAssistantStore(join(root, 'database.sqlite'));
      const ambiguous = make();
      await assert.rejects(ambiguous.session.initialize(), /无法安全核对/u);
      const unavailable = await ambiguous.selection.getOptions();
      assert.equal(unavailable.selection.profileId, 'reasoning'); assert.equal(unavailable.selection.availability.available, false);
      const rejected = await ambiguous.selection.setModel({ commandId: 'ambiguous-new-command', sessionId: 'global-coordinator', profileId: 'reasoning', revision: unavailable.selection.revision });
      assert.equal(rejected.error, 'SELECTION_RECOVERY_UNAVAILABLE');
      assert.equal(setterCalls, 2);
      assert.equal(SessionManager.open(binding.piSessionPath, sessionDir, cwd).getBranch().length, entries);
      assert.equal(defaultCalls, 1);
      return;
    }
    const transcript = buildSessionContext(SessionManager.open(binding.piSessionPath, sessionDir, cwd).getBranch());
    assert.equal(transcript.model?.modelId, reasoning.id); assert.equal(transcript.thinkingLevel, level);
    first.adapter.dispose(); store.close();
    if (scenario === 'bindingless' || scenario === 'missing-session') {
      const inspection = new DatabaseSync(join(root, 'database.sqlite'));
      inspection.exec('DELETE FROM assistant_session_binding;'); inspection.close();
      if (scenario === 'bindingless') {
        const foreign = ensurePersistedSessionManager(SessionManager.create(cwd, sessionDir), { cwd, sessionDir });
        foreign.appendModelChange(plain.provider, plain.id); foreign.appendThinkingLevelChange('off');
      } else await rm(binding.piSessionPath);
    }
    store = new SqliteAssistantStore(join(root, 'database.sqlite'));
    const reopened = make();
    if (scenario === 'missing-session') {
      await assert.rejects(reopened.session.initialize());
      const unavailable = await reopened.selection.getOptions();
      assert.equal(unavailable.selection.profileId, 'reasoning'); assert.equal(unavailable.selection.availability.available, false);
      assert.equal(defaultCalls, 1); assert.equal(setterCalls, 1);
      assert.deepEqual(await readdir(sessionDir), []);
      return;
    }
    const restoredBinding = await reopened.session.initialize();
    const restored = await reopened.selection.getOptions();
    assert.equal(restoredBinding.piSessionId, binding.piSessionId);
    assert.equal(restored.selection.profileId, 'reasoning'); assert.equal(restored.selection.modelId, reasoning.id);
    assert.equal(restored.selection.thinkingLevel, level); assert.equal(restored.selection.availability.available, true, JSON.stringify(restored));
    assert.equal(defaultCalls, 1); assert.equal(store.getBinding('global-coordinator')?.modelId, reasoning.id);
    assert.equal(store.getSelection('global-coordinator')?.pending, null);
    const replay = scenario === 'model-intent'
      ? await reopened.selection.setModel({ commandId: 'sdk-model', sessionId: 'global-coordinator', profileId: 'reasoning', revision: 0 })
      : await reopened.selection.setThinkingLevel({ commandId: 'sdk-thinking', sessionId: 'global-coordinator', thinkingLevel: level, revision: 1 });
    assert.equal(replay.replayed, true); assert.equal(replay.status, scenario === 'model-intent' || scenario === 'thinking-intent' ? 'failed' : 'succeeded');
    assert.equal(setterCalls, 1);
    const after = buildSessionContext(SessionManager.open(binding.piSessionPath, sessionDir, cwd).getBranch());
    assert.equal(after.thinkingLevel, level);
    assert.equal((await readFile(join(root, 'database.sqlite'))).includes(Buffer.from('offline-sdk-selection-secret')), false);
    // 撤销凭据后，引用不被替换；既有真实 session 仍可只读恢复，send 校验失败。
    await writeFile(authPath, '{}');
    const lostAuth = await reopened.selection.getOptions();
    assert.equal(lostAuth.selection.profileId, 'reasoning'); assert.equal(lostAuth.selection.availability.available, false);
    await assert.rejects(reopened.selection.validateForSend());
    reopened.adapter.dispose(); store.close(); store = new SqliteAssistantStore(join(root, 'database.sqlite'));
    const noAuth = make(); await noAuth.session.initialize();
    assert.equal((await noAuth.selection.getOptions()).selection.availability.available, false);
    assert.equal(defaultCalls, 1);
  } finally { for (const adapter of adapters) adapter.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
