import assert from 'node:assert/strict';
import test from 'node:test';
import { Check } from 'typebox/value';
import { CompactSessionContextSchema, SessionContextResponseSchema, type SessionContextState } from '@multivac/contracts';
import type { CoordinatorAdapter, CoordinatorContextManagementPort } from '../src/modules/sessions/coordinator-adapter.js';
import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { SessionContextManagementService } from '../src/application/session-context-management-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const id = 'global-coordinator';
const model = { provider: 'controlled', modelId: 'controlled', source: 'base' as const, protocol: null, profileId: null };
const item = { status: 'unknown' as const, explanation: '受控适配器用例，不代表真实提供方覆盖。' };
const snapshot: SessionContextState = {
  sessionId: id, revision: 'r1', current: { sessionId: id, revision: 'r1', model, contextWindow: 1000,
    observedAt: '2026-10-26T00:00:00.000Z', measuredAt: null, stale: false, staleReason: null,
    coverage: { systemPrompt: item, toolDefinitions: item, summary: item, toolResults: item, attachments: item },
    source: 'unavailable', tokens: null, basis: null, unavailableReason: '受控用例没有真实请求计数。' },
  lastRequest: null, compaction: { available: true, model, reason: null },
};
const command = (operationId: string) => ({ sessionId: id, operationId, revision: 'r1' });
function fixture() {
  const store = new SqliteAssistantStore(':memory:');
  store.bindings.insertIfAbsent({ assistantSessionId: id, harness: 'pi', runtimeSessionId: 'runtime', runtimeSessionRef: '/controlled/transcript', updatedAt: snapshot.current.observedAt });
  let calls = 0;
  let running = false;
  const port: CoordinatorContextManagementPort = {
    readContext: () => ({ ok: true, value: structuredClone(snapshot) }),
    compactContext: async () => { calls++; throw new Error('controlled native failure'); },
    reconcileCompaction: ({ operation }) => ({ ok: true, value: operation }),
  };
  const adapter = { capabilities: { contextSnapshot: true, nativeCompaction: true }, contextManagement: port,
    validateModelSelection: async () => ({ ok: true, value: true }),
    readModelSelection: () => ({ ok: true, value: { runtimeSessionId: 'runtime', runtimeSessionRef: '/controlled/transcript', durable: true,
      model: { provider: model.provider, modelId: model.modelId, source: 'base', thinkingLevel: 'off' }, availableThinkingLevels: ['off'] } }),
  } as unknown as CoordinatorAdapter;
  const lock = new AssistantOperationLock();
  const options = { sessionId: id, adapter, repository: store.contextCompactions, bindings: store.bindings, lock,
    supported: () => true, isRunning: () => running, onChanged: () => {}, now: () => snapshot.current.observedAt };
  return { store, port, adapter, options, service: new SessionContextManagementService(options), calls: () => calls, running: (value: boolean) => { running = value; } };
}

test('上下文只读查询不创建运行时，不调用压缩，未知不允许伪装 0', () => {
  const h = fixture();
  try {
    const response = h.service.get();
    assert.equal(Check(SessionContextResponseSchema, response), true);
    assert.equal(response.state.current.tokens, null);
    assert.equal(h.store.contextCompactions.latest(id), undefined);
    assert.equal(h.calls(), 0);
    assert.equal(Check(SessionContextResponseSchema, { ...response, state: { ...response.state, current: { ...response.state.current, tokens: 0 } } }), false);
    assert.equal(Check(CompactSessionContextSchema, { ...command('c'), instructions: '不允许自定义模板' }), false);
  } finally { h.store.close(); }
});

test('原生能力关闭、运行中、宿主排除、revision 失效均不调用模型；同 ID 参数冲突', async () => {
  const h = fixture();
  try {
    for (const [name, options] of [
      ['capability', { ...h.options, adapter: { ...h.adapter, capabilities: { ...h.adapter.capabilities, nativeCompaction: false } } }],
      ['host', { ...h.options, supported: () => false }],
      ['running', { ...h.options, isRunning: () => true }],
    ] as const) {
      const service = new SessionContextManagementService(options);
      const first = await service.compact(command(name));
      assert.equal(first.status, 'unavailable');
      assert.equal(first.commitState, 'not-committed');
      assert.deepEqual(await service.compact({ revision: 'r1', operationId: name, sessionId: id }), first);
    }
    assert.equal((await h.service.compact({ ...command('stale'), revision: 'old' })).status, 'unavailable');
    await assert.rejects(h.service.compact({ ...command('stale'), revision: 'new' }), /参数不一致/);
    assert.equal(h.calls(), 0);
  } finally { h.store.close(); }
});

test('同 ID 与双窗口不同 ID 并发均只取得一次执行资格；先持久化再调用端口', async () => {
  const h = fixture();
  let release!: (value: Awaited<ReturnType<CoordinatorContextManagementPort['compactContext']>>) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  h.port.compactContext = async input => {
    calls++;
    assert.equal(h.store.contextCompactions.get(id, input.operationId)?.operation.status, 'running');
    started();
    return new Promise(resolve => { release = resolve; });
  };
  try {
    const first = h.service.compact(command('original'));
    await startedPromise;
    assert.equal(h.service.blocksExecution(), true);
    const secondWindow = new SessionContextManagementService(h.options);
    assert.equal((await secondWindow.compact(command('other'))).status, 'unavailable');
    assert.equal((await h.service.compact(command('original'))).status, 'running');
    const original = h.store.contextCompactions.get(id, 'original')!.operation;
    release({ ok: true, value: { ...original, status: 'succeeded', commitState: 'committed', finishedAt: snapshot.current.observedAt, after: snapshot.current } });
    assert.equal((await first).status, 'succeeded');
    assert.equal((await h.service.compact(command('original'))).status, 'succeeded');
    assert.equal(h.service.blocksExecution(), false);
    assert.equal(calls, 1);
  } finally { h.store.close(); }
});

test('未知返回及服务恢复只读取原操作，保持占用，不把 throw 当成已回滚', async () => {
  const h = fixture();
  try {
    const result = await h.service.compact(command('unknown'));
    assert.equal(result.status, 'reconciliation-required');
    assert.equal(result.commitState, 'unknown');
    assert.equal(h.service.blocksExecution(), true);
    const recovered = new SessionContextManagementService(h.options);
    for (let i = 0; i < 3; i++) {
      assert.equal(recovered.get().operation?.status, 'reconciliation-required');
      assert.equal((await recovered.compact(command('unknown'))).status, 'reconciliation-required');
    }
    assert.equal(recovered.blocksExecution(), true);
    assert.equal(h.calls(), 1);
    assert.doesNotMatch(JSON.stringify(recovered.get()), /controlled native failure|controlled\/transcript/);
  } finally { h.store.close(); }
});

test('意图保存失败不派发原生调用；意图可能已提交时仍保持阻塞', async () => {
  const h = fixture();
  try {
    const service = new SessionContextManagementService({ ...h.options, repository: {
      get: (...args) => h.options.repository.get(...args), latest: id => h.options.repository.latest(id), pending: id => h.options.repository.pending(id),
      insert: record => { h.options.repository.insert(record); throw new Error('unknown database acknowledgment'); }, finish: () => {},
    } });
    await assert.rejects(service.compact(command('intent-failure')));
    assert.equal(h.calls(), 0);
    assert.equal(service.blocksExecution(), true);
  } finally { h.store.close(); }
});

test('结果保存失败保持待核对，不允许下一次压缩', async () => {
  const h = fixture();
  try {
    h.port.compactContext = async input => {
      const operation = h.store.contextCompactions.get(id, input.operationId)!.operation;
      return { ok: true, value: { ...operation, status: 'cancelled', commitState: 'not-committed', finishedAt: snapshot.current.observedAt } };
    };
    const service = new SessionContextManagementService({ ...h.options, repository: {
      get: (...args) => h.options.repository.get(...args), latest: id => h.options.repository.latest(id), pending: id => h.options.repository.pending(id),
      insert: record => h.options.repository.insert(record), finish: () => { throw new Error('disk full'); },
    } });
    assert.equal((await service.compact(command('finish-failure'))).status, 'reconciliation-required');
    assert.equal(service.blocksExecution(), true);
    assert.equal(service.getOperation('finish-failure')?.commitState, 'unknown');
  } finally { h.store.close(); }
});

test('操作按会话隔离；其他会话读取不到原操作', async () => {
  const h = fixture();
  try {
    await h.service.compact(command('owned'));
    assert.equal(h.store.contextCompactions.get('other-session', 'owned'), undefined);
    await assert.rejects(h.service.compact({ ...command('wrong-session'), sessionId: 'other-session' }), /目标会话不一致/);
  } finally { h.store.close(); }
});

test('实际 SQLite 关闭重开后保留原意图和占用，恢复查询不写入或重发', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(process.cwd(), '.context-recovery-'));
  const path = join(root, 'data.sqlite');
  let store = new SqliteAssistantStore(path);
  const h = fixture();
  try {
    const record = { fingerprint: 'fixed', identity: null, operation: {
      operationId: 'persisted', sessionId: id, model, status: 'running' as const, commitState: 'unknown' as const,
      startedAt: snapshot.current.observedAt, updatedAt: snapshot.current.observedAt, finishedAt: null,
      runtimeCommitRef: null, before: snapshot.current, after: null, error: null,
    } };
    store.contextCompactions.insert(record);
    store.close();
    store = new SqliteAssistantStore(path);
    const service = new SessionContextManagementService({ ...h.options, repository: store.contextCompactions });
    assert.equal(service.blocksExecution(), true);
    assert.equal(service.getOperation('persisted')?.status, 'reconciliation-required');
    assert.deepEqual(store.contextCompactions.get(id, 'persisted'), record, 'GET 不改写持久记录');
    assert.equal(h.calls(), 0);
  } finally { h.store.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('会话运行时：压缩意图未对账时拒绝发送、选模及生命周期释放', async () => {
  const { AssistantSessionRuntime } = await import('../src/application/assistant-session-runtime.js');
  const { FakeCoordinatorAdapter } = await import('../src/runtime/executors/fake-coordinator-adapter.js');
  const { AssistantEventStream } = await import('../src/application/assistant-event-stream.js');
  const { ModelSettingsService } = await import('../src/application/model-settings-service.js');
  const { FakeModelSettingsCatalogFactory } = await import('../src/runtime/executors/fake-model-settings-catalog.js');
  const store = new SqliteAssistantStore(':memory:');
  const adapter = new FakeCoordinatorAdapter();
  const config = { systemPrompt: '受控运行时', authorizedContext: [], model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' as const },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1000 } };
  const settings = new ModelSettingsService({ load: async () => ({ revision: 0, defaultProfileId: null, profiles: [], commands: [] }), save: async () => {} }, new FakeModelSettingsCatalogFactory());
  const runtime = new AssistantSessionRuntime({ adapter, bindingRepository: store.bindings, pageStateRepository: store.pageStates,
    commandRepository: store.commands, eventRepository: store.events, selectionRepository: store.selections,
    contextCompactions: store.contextCompactions, eventStream: new AssistantEventStream(), modelSettingsService: settings,
  }, { sessionId: id, kind: 'coordinator', runtimeConfig: config, resolveNewSessionRuntimeConfig: async () => config,
    resolveWorkingDirectory: () => ({ kind: 'session-temp', path: '/controlled/workspace' }) });
  try {
    const calls = adapter.calls.length;
    runtime.context!.get();
    assert.equal(adapter.calls.length, calls, '查询不调用 create/continue 或模型');
    await runtime.initialize();
    store.contextCompactions.insert({ fingerprint: 'fixed', identity: null, operation: {
      operationId: 'uncertain', sessionId: id, model, status: 'reconciliation-required', commitState: 'unknown',
      startedAt: snapshot.current.observedAt, updatedAt: snapshot.current.observedAt, finishedAt: null,
      runtimeCommitRef: null, before: snapshot.current, after: null, error: null,
    } });
    assert.equal(runtime.isRunning(), true, '生命周期据此拒绝归档或迁移');
    await assert.rejects(runtime.commands.send({ commandId: 'send', assistantSessionId: id, text: '不应发送', contextRefs: [] }), /压缩正在执行或待核对/);
    const selection = await runtime.selection.getOptions();
    const result = await runtime.selection.setThinkingLevel({ commandId: 'select', sessionId: id, revision: selection.selection.revision, thinkingLevel: 'off' });
    assert.equal(result.error, 'SESSION_RUNNING');
    assert.equal(adapter.calls.some(call => call.method === 'prompt'), false);
  } finally { runtime.dispose(); adapter.dispose(); store.close(); }
});
