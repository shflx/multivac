import { AssistantOperationLock } from '../src/application/assistant-operation-lock.js';
import { SessionContextManagementService } from '../src/application/session-context-management-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { reconcilePiCompaction } from '../src/runtime/executors/pi-context-compaction.js';
import type { ContextCompactionOperation } from '@multivac/contracts';
import { POST_COMPACTION_BASIS, readPiContext } from '../src/runtime/executors/pi-context-snapshot.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { DefaultPiCoordinatorSessionFactory, type PiCoordinatorSessionResources } from '../src/runtime/executors/pi-session-factory.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';
import { completedItems, controlledFetch, responsesSDK, terminal } from './fixtures/responses-stream.js';

const observations: { scenario: string; [key: string]: unknown }[] = [];
after(async () => {
  if (process.env.MULTIVAC_CONTEXT_EVIDENCE !== '1') return;
  const dependency = JSON.parse(await readFile(new URL('../../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8'));
  await mkdir('artifacts/context-management', { recursive: true });
  await writeFile('artifacts/context-management/t1-observations.json', JSON.stringify({
    recordedAt: new Date().toISOString(), node: process.version, dependency: `${dependency.name}@${dependency.version}`,
    sdk: '真实', persistence: '真实文件系统', modelTransport: '受控内存 SSE', realModel: '未验证', browser: '未验证', observations,
  }, null, 2) + '\n');
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

// 真实 Pi SDK、原生摘要生成与文件读写；仅模型传输替换为内存 SSE，不代表真实模型验证。
// 临时目录限定在任务 cwd，禁止使用全局 Pi 配置、其他会话或真实凭据。
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), '.pi-context-test-'));
  const cwd = join(root, 'work');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd); await mkdir(agentDir);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'offline-placeholder' } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
  const model = runtime.getModels('openai').find(item => item.api === 'openai-responses' && !item.reasoning && item.input.includes('image'))!;
  assert.ok(model);
  const config: CoordinatorRuntimeConfig = {
    systemPrompt: '受控系统提示，只验证上下文能力。', authorizedContext: [],
    model: { provider: model.provider, modelId: model.id, source: 'base', thinkingLevel: 'off' },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 20 },
  };
  let actual!: Awaited<ReturnType<typeof createAgentSession>>['session'];
  let mode: 'success' | 'failure' | 'cancel' = 'success';
  let started!: () => void;
  let requests = 0;
  const contexts: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] }[] = [];
  const factory = new DefaultPiCoordinatorSessionFactory({
    authPath, modelsPath: null, temporaryRoot: root,
    createModelRuntime: async () => runtime,
    createAgentSession: async options => {
      const result = await createAgentSession(options);
      actual = result.session;
      actual.agent.streamFunction = (requestModel, context, options) => {
        requests++;
        contexts.push(context);
        const events = mode === 'cancel' ? [{ type: 'response.created', response: { id: 'controlled' } }]
          : mode === 'failure' ? [terminal('response.failed', { error: { code: 'controlled_failure', message: 'controlled failure' } })]
            : [...completedItems(), terminal()];
        const source = controlledFetch(events);
        return responsesSDK.streamSimple(requestModel, context, { ...options, apiKey: 'controlled', fetch: source.fetch, onResponse: () => started?.() });
      };
      return result;
    },
  });
  const input = { assistantSessionId: 'controlled', cwd, agentDir, sessionDir, config };
  const resources = await factory.create(input);
  const sessionFile = actual.sessionFile!;
  const seed = () => {
    for (let index = 0; index < 4; index++) {
      actual.sessionManager.appendMessage({ role: 'user', content: `受控早期消息 ${index} ${'内容'.repeat(80)}`, timestamp: Date.now() });
      actual.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `受控回复 ${index}` }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 9, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 19, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    }
    actual.agent.state.messages = actual.sessionManager.buildSessionContext().messages;
  };
  return { root, cwd, sessionDir, sessionFile, model, config, resources, contexts, seed,
    get actual() { return actual; }, get requests() { return requests; },
    setMode(value: typeof mode) { mode = value; },
    waitForRequest() { return new Promise<void>(resolve => { started = resolve; }); },
    reopen: async () => factory.open({ ...input, sessionPath: sessionFile }),
    close: async () => { actual.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

test('Pi 0.85.1：原生占用为 usage 加启发式尾部，不是完整请求 token 计数', async () => {
  const f = await fixture();
  try {
    const snapshots = [{ stage: 'empty', ...f.actual.getContextUsage() }];
    assert.equal(f.actual.getContextUsage()?.tokens, 0, '空消息估算 0 没有包含真实系统提示和工具定义');
    assert.ok(f.actual.agent.state.systemPrompt.length > 0);
    assert.ok(f.actual.getActiveToolNames().length > 0);
    f.seed();
    assert.equal(f.actual.getContextUsage()?.tokens, 19, '包括缓存输入及输出，不能标成最近请求实际输入');
    snapshots.push({ stage: 'usage-with-cache-and-output', ...f.actual.getContextUsage() });
    const last = f.actual.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    assert.ok(last?.type === 'message' && last.message.role === 'assistant');
    const usage = last.message.usage;
    assert.equal(usage.input + usage.cacheRead + usage.cacheWrite, 14, '最近请求实际输入应包括缓存，不包含输出');
    f.actual.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'controlled', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(400) }], isError: false, timestamp: Date.now() });
    f.actual.agent.state.messages = f.actual.sessionManager.buildSessionContext().messages;
    assert.equal(f.actual.getContextUsage()?.tokens, 119, '新增工具结果按字符 / 4 估算');
    snapshots.push({ stage: 'trailing-tool-result', ...f.actual.getContextUsage() });
    f.actual.sessionManager.appendMessage({ role: 'user', content: [{ type: 'image', data: 'controlled-image', mimeType: 'image/png' }], timestamp: Date.now() });
    f.actual.agent.state.messages = f.actual.sessionManager.buildSessionContext().messages;
    assert.equal(f.actual.getContextUsage()?.tokens, 1319, '图片固定估算 1200，不是视觉 token');
    snapshots.push({ stage: 'trailing-image', ...f.actual.getContextUsage() });
    f.actual.agent.state.model = { ...f.model, id: 'another-model', contextWindow: 7777 };
    assert.equal(f.actual.getContextUsage()?.tokens, 1319, 'Pi 未排除旧模型 usage');
    assert.equal(f.actual.getContextUsage()?.contextWindow, 7777, '应用层必须阻止旧模型 usage 套新窗口');
    snapshots.push({ stage: 'different-model', ...f.actual.getContextUsage() });
    observations.push({ scenario: 'context-usage', snapshots, lastRequestInputWithCache: usage.input + usage.cacheRead + usage.cacheWrite });
  } finally { await f.close(); }
});

test('Pi 原生压缩成功：历史保留、压缩后未知、文件重开恢复并可继续对话', async () => {
  const f = await fixture();
  try {
    f.seed();
    const before = mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch());
    const result = await f.actual.compact();
    assert.ok(result.summary);
    assert.ok(f.contexts[0]?.systemPrompt);
    assert.ok(f.requests > 0, '调用真实原生摘要链路，模型传输受控');
    assert.equal(f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 1);
    assert.equal(f.actual.getContextUsage()?.tokens, null);
    const requests = f.requests;
    await assert.rejects(f.actual.compact(), /Already compacted/);
    assert.equal(f.requests, requests, '重复原生压缩不应再次调用模型');
    assert.deepEqual(mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch()), before);
    const afterCompaction = f.actual.getContextUsage();
    const expectedContext = f.actual.sessionManager.buildSessionContext();
    const file = await readFile(f.sessionFile, 'utf8');
    assert.ok(file.includes('"type":"compaction"'));
    f.actual.dispose();
    await f.reopen();
    assert.deepEqual(f.actual.sessionManager.buildSessionContext(), expectedContext);
    assert.deepEqual(mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch()), before);
    assert.equal(f.actual.model?.id, f.model.id);
    await f.actual.prompt('压缩后继续对话');
    const continued = f.contexts.at(-1)!;
    assert.ok(continued.systemPrompt?.includes('受控系统提示'));
    assert.ok(continued.tools?.length, '真实 Pi 请求携带工具定义');
    assert.ok(JSON.stringify(continued.messages).includes(result.summary), '摘要进入后续请求');
    assert.ok(mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch()).length > before.length);
    assert.equal(f.actual.getContextUsage()?.tokens, 16);
    observations.push({ scenario: 'native-success-and-reopen', model: { provider: f.model.provider, modelId: f.model.id },
      visibleHistoryBefore: before.length, historyRetained: true, nativeCompactions: f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length,
      afterCompaction, afterContinuation: f.actual.getContextUsage(), contextRestoredFromFile: true, continued: true, modelRequests: f.requests });
  } finally { await f.close(); }
});

test('Pi 摘要请求失败及取消：不追加压缩，原历史与持久状态保持一致', async () => {
  for (const mode of ['failure', 'cancel'] as const) {
    const f = await fixture();
    try {
      f.seed();
      const before = await readFile(f.sessionFile, 'utf8');
      const entries = structuredClone(f.actual.sessionManager.getBranch());
      const events: { type: string; aborted?: boolean; result?: unknown }[] = [];
      f.actual.subscribe(event => { events.push(event); });
      f.setMode(mode);
      const started = f.waitForRequest();
      const operation = f.actual.compact();
      const rejected = assert.rejects(operation, mode === 'cancel' ? /Compaction cancelled/ : /controlled failure/);
      await started;
      if (mode === 'cancel') f.actual.abortCompaction();
      await rejected;
      assert.equal(f.actual.isIdle, true);
      assert.equal(await readFile(f.sessionFile, 'utf8'), before);
      assert.deepEqual(f.actual.sessionManager.getBranch(), entries);
      const ended = events.find(event => event.type === 'compaction_end');
      assert.equal(ended?.aborted, mode === 'cancel');
      assert.equal(ended?.result, undefined);
      f.actual.dispose(); await f.reopen();
      assert.deepEqual(f.actual.sessionManager.getBranch(), entries);
      observations.push({ scenario: mode, ended: { type: ended?.type, aborted: ended?.aborted, hasResult: ended?.result !== undefined },
        idleAfter: f.actual.isIdle, beforeFileSha256: digest(before), afterFileSha256: digest(await readFile(f.sessionFile, 'utf8')), nativeCompactions: entries.filter(entry => entry.type === 'compaction').length, reopened: true });
    } finally { await f.close(); }
  }
});

test('Pi 无可压缩内容：拒绝且不发出模型请求', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.sessionFile, 'utf8');
    await assert.rejects(f.actual.compact(), /Nothing to compact/);
    assert.equal(f.requests, 0);
    assert.equal(await readFile(f.sessionFile, 'utf8'), before);
    observations.push({ scenario: 'no-content', modelRequests: f.requests, fileUnchanged: true });
  } finally { await f.close(); }
});

test('Pi 持久写入失败：内存已追加压缩而磁盘未提交，不能把异常解释为已回滚', async () => {
  const f = await fixture();
  try {
    f.seed();
    const before = await readFile(f.sessionFile, 'utf8');
    const backup = `${f.sessionFile}.saved`;
    await rename(f.sessionFile, backup);
    await mkdir(f.sessionFile); // 真实文件系统拒绝追加，不修改 Pi 实现或伪造异常。
    await assert.rejects(f.actual.compact(), /EISDIR/);
    assert.equal(f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 1);
    assert.equal(f.actual.messages.some(message => message.role === 'compactionSummary'), false, 'Agent 消息尚未替换');
    assert.equal(await readFile(backup, 'utf8'), before);
    const memoryCompactionsAfterError = f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length;
    const agentContextReplacedAfterError = f.actual.messages.some(message => message.role === 'compactionSummary');
    await rm(f.sessionFile, { recursive: true });
    await rename(backup, f.sessionFile);
    f.actual.dispose(); await f.reopen();
    assert.equal(f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
    assert.equal(await readFile(f.sessionFile, 'utf8'), before);
    observations.push({ scenario: 'native-persistence-failure', fault: '真实 EISDIR', memoryCompactionsAfterError, agentContextReplacedAfterError,
      persistedCompactionsAfterReopen: f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length,
      beforeFileSha256: digest(before), afterFileSha256: digest(await readFile(f.sessionFile, 'utf8')), nativeAutomaticRollback: false });
  } finally { await f.close(); }
});

test('Pi 真实请求携带系统、工具、工具结果、资料和图片；测试流不证明真实计数覆盖', async () => {
  const f = await fixture();
  try {
    f.seed();
    const assistant = f.actual.messages.at(-1)!;
    assert.ok(assistant.role === 'assistant');
    f.actual.sessionManager.appendMessage({ ...assistant, content: [{ type: 'toolCall', id: 'controlled-call', name: 'read', arguments: { path: 'controlled.txt' } }] });
    f.actual.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'controlled-call', toolName: 'read', content: [{ type: 'text', text: '受控工具结果' }], isError: false, timestamp: Date.now() });
    f.actual.agent.state.messages = f.actual.sessionManager.buildSessionContext().messages;
    await f.actual.sendCustomMessage({ customType: 'controlled-context', content: '受控资料', display: false });
    await f.actual.prompt('包含图片的受控请求', { images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }] });
    const context = f.contexts.at(-1)!;
    assert.ok(context.systemPrompt?.includes('受控系统提示'));
    assert.ok(context.tools?.length);
    const serialized = JSON.stringify(context.messages);
    assert.ok(serialized.includes('受控工具结果'));
    assert.ok(serialized.includes('受控资料'));
    assert.ok(serialized.includes('image/png'));
    assert.equal(f.actual.getContextUsage()?.tokens, 16, '该值来自受控 SSE usage，并不按实际内容计算');
    observations.push({ scenario: 'native-request-coverage', systemPromptPresent: !!context.systemPrompt, toolDefinitionsPresent: !!context.tools?.length,
      toolResultPresent: serialized.includes('受控工具结果'), customContextPresent: serialized.includes('受控资料'), imagePresent: serialized.includes('image/png'), realProviderTokenCoverage: '未验证' });
  } finally { await f.close(); }
});

test('Pi 应用能力声明原生压缩，但未打开运行时仍拒绝执行', async () => {
  const f = await fixture();
  const adapter = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), sessionDir: f.sessionDir });
  try {
    assert.equal(adapter.capabilities.nativeCompaction, true);
    assert.equal(adapter.capabilities.contextSnapshot, true);
    assert.equal(adapter.contextManagement.readContext('not-opened').ok, false);
    assert.equal((await adapter.contextManagement.compactContext({ operationId: 'blocked', sessionId: 'not-opened', expectedRevision: 'none', expectedModel: { provider: 'openai', modelId: 'controlled', source: 'base', profileId: null, protocol: null } })).ok, false);
  } finally { adapter.dispose(); await f.close(); }
});


test('应用快照：空消息不伪装零，缓存输入完整计入，查询不调用模型', async () => {
  const f = await fixture();
  try {
    const read = () => readPiContext('controlled', f.resources.session, f.config.model, '2026-10-26T00:00:00.000Z');
    assert.equal(read().current.source, 'unavailable');
    assert.equal(read().current.tokens, null);
    f.seed();
    const state = read();
    assert.equal(state.current.source, 'current-estimate');
    assert.equal(state.current.tokens, 19);
    assert.equal(state.lastRequest?.source, 'last-request-input');
    assert.equal(state.lastRequest?.tokens, 14);
    assert.equal(state.lastRequest?.contextWindow, null, '缺少请求时窗口记录，不套当前模型目录');
    assert.equal(state.lastRequest?.model?.source, null, '历史消息没有 profile 来源，不冒充当前选择');
    assert.equal(f.requests, 0);
    assert.equal(state.compaction.available, true);
  } finally { await f.close(); }
});

test('应用快照：模型变更不套旧用量，压缩后按字符粗估，历史请求保留原模型', async () => {
  const f = await fixture();
  try {
    f.seed();
    const before = readPiContext('controlled', f.resources.session, f.config.model, '2026-10-26T00:00:00.000Z');
    f.actual.agent.state.model = { ...f.model, id: 'another-model', contextWindow: 7777 };
    const changed = readPiContext('controlled', f.resources.session, f.config.model, '2026-10-26T00:00:01.000Z');
    assert.equal(changed.current.tokens, null);
    assert.equal(changed.current.contextWindow, 7777);
    assert.equal(changed.lastRequest?.model?.modelId, f.model.id);
    assert.equal(changed.lastRequest?.contextWindow, null);
    assert.equal(changed.lastRequest?.stale, true);
    assert.notEqual(changed.revision, before.revision);
    f.actual.agent.state.model = f.model;
    await f.actual.compact();
    const compacted = readPiContext('controlled', f.resources.session, f.config.model, '2026-10-26T00:00:02.000Z');
    assert.equal(compacted.current.source, 'current-estimate');
    assert.equal(compacted.current.basis, POST_COMPACTION_BASIS);
    assert.ok((compacted.current.tokens ?? 0) > 0, '压缩后不再显示未知，改为字符粗估');
    assert.equal(compacted.current.stale, false);
    assert.equal(compacted.lastRequest?.tokens, 14);
    assert.equal(compacted.lastRequest?.stale, true);
  } finally { await f.close(); }
});

test('应用快照：后续回复缺失输入统计或同名模型被重新配置时，不沿用旧估算', async () => {
  for (const scenario of ['missing-usage', 'same-model-change']) {
    const f = await fixture();
    try {
      f.seed();
      if (scenario === 'missing-usage') {
        f.actual.sessionManager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '没有输入用量的后续回复' }],
          api: f.model.api, provider: f.model.provider, model: f.model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      } else {
        f.actual.sessionManager.appendModelChange(f.model.provider, f.model.id);
      }
      f.actual.agent.state.messages = f.actual.sessionManager.buildSessionContext().messages;
      const state = readPiContext('controlled', f.resources.session, f.config.model, '2026-10-26T00:00:00.000Z');
      assert.equal(state.current.source, 'unavailable');
      assert.equal(state.current.tokens, null);
      assert.equal(state.lastRequest?.tokens, 14, '旧请求仍可查看，但不冒充当前占用');
      assert.equal(state.lastRequest?.stale, true);
    } finally { await f.close(); }
  }
});


// 把已创建的真实 SDK 会话交给适配器，避免为应用层联合测试另建第二份运行时。
function fixedResources(resources: PiCoordinatorSessionResources) {
  return { create: async () => resources, open: async () => resources, continue: async () => resources };
}

function operation(f: Awaited<ReturnType<typeof fixture>>, id = 'native-operation'): ContextCompactionOperation {
  const state = readPiContext('controlled', f.resources.session, f.config.model, new Date().toISOString());
  return { operationId: id, sessionId: 'controlled', model: state.compaction.model, status: 'running',
    commitState: 'unknown', runtimeCommitRef: null, startedAt: state.current.observedAt, updatedAt: state.current.observedAt,
    finishedAt: null, before: state.current, after: null, error: null };
}
const identity = (f: Awaited<ReturnType<typeof fixture>>) => ({ harness: 'pi', runtimeSessionId: f.actual.sessionId, runtimeSessionRef: f.sessionFile });

test('可靠原生链路：成功有唯一提交证据，原记录可只读恢复，历史及后续对话保留', async () => {
  const f = await fixture();
  try {
    f.seed();
    const before = mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch());
    const op = operation(f);
    const result = await f.resources.session.compactContext!(op);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.commitState, 'committed');
    assert.ok(result.runtimeCommitRef);
    assert.deepEqual(mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch()), before);
    const requests = f.requests;
    const proof = reconcilePiCompaction(identity(f), op);
    assert.equal(proof.status, 'succeeded', '模拟提交成功但应用应答丢失');
    assert.equal(proof.runtimeCommitRef, result.runtimeCommitRef);
    assert.equal(f.requests, requests, '核对不发起新请求');
    f.actual.dispose(); await f.reopen();
    assert.equal(reconcilePiCompaction(identity(f), op).status, 'succeeded');
    const summary = f.actual.sessionManager.getBranch().find(entry => entry.type === 'compaction');
    assert.ok(summary?.type === 'compaction');
    await f.actual.prompt('恢复压缩后继续');
    assert.ok(JSON.stringify(f.contexts.at(-1)!.messages).includes(summary.summary));
    assert.equal(reconcilePiCompaction(identity(f), op).status, 'succeeded', '后续对话不改变原提交证明');
    assert.ok(mapPiActiveBranch(f.actual.sessionId, f.actual.sessionManager.getBranch()).length > before.length);
  } finally { await f.close(); }
});

test('可靠原生链路：失败、取消及无内容均核对磁盘并恢复原消息', async () => {
  for (const scenario of ['failure', 'cancel', 'empty'] as const) {
    const f = await fixture();
    try {
      if (scenario !== 'empty') f.seed();
      const before = await readFile(f.sessionFile, 'utf8');
      const messages = structuredClone(f.actual.messages);
      if (scenario !== 'empty') f.setMode(scenario);
      const started = f.waitForRequest();
      const op = operation(f);
      const pending = f.resources.session.compactContext!(op);
      if (scenario === 'cancel') { await started; f.actual.abortCompaction(); }
      const result = await pending;
      assert.equal(result.status, scenario === 'failure' ? 'failed' : scenario === 'cancel' ? 'cancelled' : 'no-content');
      assert.equal(result.commitState, 'not-committed');
      assert.equal(await readFile(f.sessionFile, 'utf8'), before);
      assert.deepEqual(f.actual.messages, messages);
      if (scenario === 'empty') assert.equal(f.requests, 0);
      assert.equal(reconcilePiCompaction(identity(f), op).status, result.status, '取消与无内容的回执可恢复');
      f.setMode('success');
      await f.actual.prompt('操作终结后继续');
      assert.equal(reconcilePiCompaction(identity(f), op).status, result.status, '后续追加不改变原终态');
      f.seed();
      assert.equal((await f.resources.session.compactContext!(operation(f, 'later-operation'))).status, 'succeeded');
      assert.equal(reconcilePiCompaction(identity(f), op).status, result.status, '后来另一次压缩不冒充原失败或取消操作的提交');
    } finally { await f.close(); }
  }
});

test('可靠原生链路：真实写盘拒绝后恢复磁盘，丢弃 SDK 已污染的内存分支', async () => {
  const f = await fixture();
  try {
    f.seed();
    const before = await readFile(f.sessionFile, 'utf8');
    const messages = structuredClone(f.actual.messages);
    const { renameSync, mkdirSync, rmSync } = await import('node:fs');
    const manager = f.actual.sessionManager;
    const append = manager.appendCompaction.bind(manager);
    manager.appendCompaction = (...args) => {
      const backup = f.sessionFile + '.saved';
      renameSync(f.sessionFile, backup); mkdirSync(f.sessionFile);
      try { return append(...args); }
      finally { rmSync(f.sessionFile, { recursive: true }); renameSync(backup, f.sessionFile); }
    };
    const result = await f.resources.session.compactContext!(operation(f));
    assert.equal(result.status, 'failed');
    assert.equal(result.commitState, 'not-committed');
    assert.equal(manager.getBranch().filter(entry => entry.type === 'compaction').length, 0);
    assert.deepEqual(f.actual.messages, messages);
    assert.equal(await readFile(f.sessionFile, 'utf8'), before);
    manager.appendCompaction = append;
    await f.actual.prompt('失败恢复后继续');
    assert.ok(f.actual.messages.length > messages.length);
  } finally { await f.close(); }
});

test('可靠原生链路：已落盘后抛错按原生提交判定成功，截断追加保持待核对', async () => {
  for (const fault of ['after-commit', 'partial'] as const) {
    const f = await fixture();
    try {
      f.seed();
      const { appendFileSync } = await import('node:fs');
      const manager = f.actual.sessionManager;
      const append = manager.appendCompaction.bind(manager);
      manager.appendCompaction = (...args) => {
        if (fault === 'after-commit') append(...args);
        else appendFileSync(f.sessionFile, '{"type":"compaction","id":');
        throw new Error('controlled persistence boundary');
      };
      const op = operation(f);
      const result = await f.resources.session.compactContext!(op);
      assert.equal(result.status, fault === 'after-commit' ? 'succeeded' : 'reconciliation-required');
      assert.equal(reconcilePiCompaction(identity(f), op).status, result.status);
      if (fault === 'after-commit') assert.ok(f.actual.messages.some(message => message.role === 'compactionSummary'));
      assert.doesNotMatch(JSON.stringify(result), /controlled persistence boundary/);
    } finally { await f.close(); }
  }
});

test('原操作核对拒绝身份、模型及前缀变更，不补写历史', async () => {
  const f = await fixture();
  try {
    f.seed();
    const op = operation(f);
    assert.equal((await f.resources.session.compactContext!(op)).status, 'succeeded');
    const file = await readFile(f.sessionFile, 'utf8');
    assert.equal(reconcilePiCompaction({ ...identity(f), runtimeSessionId: 'wrong' }, op).status, 'reconciliation-required');
    assert.equal(reconcilePiCompaction(identity(f), { ...op, model: { ...op.model!, profileId: 'wrong' } }).status, 'reconciliation-required');
    await writeFile(f.sessionFile, file.replace('受控早期消息', '改写早期消息'));
    assert.equal(reconcilePiCompaction(identity(f), op).status, 'reconciliation-required');
    assert.equal(await readFile(f.sessionFile, 'utf8'), file.replace('受控早期消息', '改写早期消息'));
  } finally { await f.close(); }
});


test('两宿主原生联合链路：SQLite 意图、实际持久模型、应答丢失、只读核对及下次压缩', async () => {
  for (const sessionId of ['work-context', 'global-coordinator']) {
    const f = await fixture();
    const database = join(f.root, 'context.sqlite');
    let store = new SqliteAssistantStore(database);
    let adapter = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), modelsPath: null,
      sessionDir: f.sessionDir, sessionFactory: fixedResources(f.resources) });
    try {
      f.seed();
      const ready = await adapter.createSession({ assistantSessionId: sessionId, config: f.config,
        workingDirectory: { kind: 'session-temp', path: f.cwd } });
      assert.ok(ready.ok);
      store.bindings.insertIfAbsent(ready.value.binding);
      const options = { sessionId, adapter, bindings: store.bindings, repository: store.contextCompactions,
        lock: new AssistantOperationLock(), supported: () => true, isRunning: () => false, onChanged: () => {} };
      // 模拟原生提交完成，但应用结果事务没有保存。证据仍由真实 SDK 与文件系统产生。
      const interrupted = new SessionContextManagementService({ ...options, repository: {
        ...options.repository,
        get: (...args) => options.repository.get(...args), latest: id => options.repository.latest(id), pending: id => options.repository.pending(id),
        insert: record => options.repository.insert(record), finish: () => { throw new Error('controlled lost result'); },
      } });
      const before = interrupted.get().state;
      assert.equal(before.compaction.available, true);
      const result = await interrupted.compact({ sessionId, operationId: 'lost-response', revision: before.revision });
      assert.equal(result.status, 'reconciliation-required');
      const requests = f.requests;
      const original = store.contextCompactions.get(sessionId, 'lost-response')!;
      assert.equal(original.operation.status, 'running');
      adapter.dispose(); store.close();
      store = new SqliteAssistantStore(database);
      const reopened = await f.reopen();
      adapter = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), modelsPath: null, sessionDir: f.sessionDir,
        sessionFactory: fixedResources(reopened) });
      const recovered = new SessionContextManagementService({ ...options, adapter, repository: store.contextCompactions, bindings: store.bindings });
      assert.equal(recovered.get().operation?.status, 'succeeded');
      assert.equal(recovered.blocksExecution(), false, '可靠核对后解除占用');
      assert.deepEqual(store.contextCompactions.get(sessionId, 'lost-response'), original, 'GET 不写账本');
      assert.equal(f.requests, requests, '恢复查询不重发原请求');
      assert.equal(adapter.contextManagement.readContext(sessionId).ok, false, '对账不初始化运行时');
      assert.ok((await adapter.continueSession({ binding: ready.value.binding, config: f.config,
        workingDirectory: { kind: 'session-temp', path: f.cwd } })).ok);
      await f.actual.prompt('核对后继续对话');
      assert.equal(recovered.getOperation('lost-response')?.status, 'succeeded');
      f.seed();
      const state = recovered.get().state;
      const next = await recovered.compact({ sessionId, operationId: 'next-operation', revision: state.revision });
      assert.equal(next.status, 'succeeded', '新命令在锁内保存原核对结果，释放 SQLite 唯一约束');
      assert.equal(store.contextCompactions.get(sessionId, 'lost-response')?.operation.status, 'succeeded');
      const repeated = await recovered.compact({ sessionId, operationId: 'lost-response', revision: before.revision });
      assert.equal(repeated.status, 'succeeded');
      assert.equal(f.actual.sessionManager.getBranch().filter(entry => entry.type === 'compaction').length, 2);
    } finally { adapter.dispose(); store.close(); await f.close(); }
  }
});

test('写盘状态未知隔离当前运行时，文件恢复后需重启核对，不因只读查询解禁受污染内存', async () => {
  const f = await fixture();
  const adapter = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), modelsPath: null,
    sessionDir: f.sessionDir, sessionFactory: fixedResources(f.resources) });
  try {
    f.seed();
    assert.ok((await adapter.createSession({ assistantSessionId: 'controlled', config: f.config,
      workingDirectory: { kind: 'session-temp', path: f.cwd } })).ok);
    const state = adapter.contextManagement.readContext('controlled');
    assert.ok(state.ok);
    const op = operation(f);
    const { renameSync, mkdirSync } = await import('node:fs');
    const append = f.actual.sessionManager.appendCompaction.bind(f.actual.sessionManager);
    f.actual.sessionManager.appendCompaction = (...args) => {
      renameSync(f.sessionFile, f.sessionFile + '.saved'); mkdirSync(f.sessionFile);
      return append(...args);
    };
    const result = await adapter.contextManagement.compactContext({ sessionId: 'controlled', operationId: op.operationId,
      expectedRevision: state.value.revision, expectedModel: state.value.compaction.model! });
    assert.ok(result.ok);
    assert.equal(result.value.status, 'reconciliation-required');
    await rm(f.sessionFile, { recursive: true }); await rename(f.sessionFile + '.saved', f.sessionFile);
    assert.equal(adapter.contextManagement.reconcileCompaction({ identity: identity(f), operation: result.value }).ok, true);
    const sameProcess = adapter.contextManagement.reconcileCompaction({ identity: identity(f), operation: result.value });
    assert.ok(sameProcess.ok);
    assert.equal(sameProcess.value.status, 'reconciliation-required');
    const restarted = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), modelsPath: null, sessionDir: f.sessionDir });
    try {
      const restored = restarted.contextManagement.reconcileCompaction({ identity: identity(f), operation: result.value });
      assert.ok(restored.ok);
      assert.equal(restored.value.status, 'failed');
      assert.equal(restored.value.commitState, 'not-committed');
    } finally { restarted.dispose(); }
  } finally { adapter.dispose(); await f.close(); }
});


test('原生证据无法保存时不调用模型，前置拒绝准确标为未提交', async () => {
  const f = await fixture();
  const adapter = new PiCoordinatorAdapter({ agentDir: join(f.root, 'agent'), modelsPath: null,
    sessionDir: f.sessionDir, sessionFactory: fixedResources(f.resources) });
  try {
    f.seed();
    const op = operation(f);
    await mkdir(`${f.sessionFile}.compact-${digest(op.operationId)}.json`);
    const before = await readFile(f.sessionFile, 'utf8');
    const rejected = await f.resources.session.compactContext!(op);
    assert.equal(rejected.status, 'unavailable');
    assert.equal(rejected.commitState, 'not-committed');
    assert.equal(f.requests, 0);
    assert.equal(await readFile(f.sessionFile, 'utf8'), before);
    assert.ok((await adapter.createSession({ assistantSessionId: 'controlled', config: f.config,
      workingDirectory: { kind: 'session-temp', path: f.cwd } })).ok);
    const state = adapter.contextManagement.readContext('controlled');
    assert.ok(state.ok);
    const stale = await adapter.contextManagement.compactContext({ operationId: 'stale', sessionId: 'controlled',
      expectedRevision: 'outdated', expectedModel: state.value.compaction.model! });
    assert.ok(stale.ok);
    assert.equal(stale.value.status, 'unavailable');
    assert.equal(stale.value.commitState, 'not-committed');
    assert.equal(f.requests, 0);
  } finally { adapter.dispose(); await f.close(); }
});
