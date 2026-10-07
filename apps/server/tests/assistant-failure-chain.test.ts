import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { AssistantPublicEvent, CoordinatorAdapterEvent } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { AssistantEventProjector } from '../src/application/assistant-event-projector.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { PiCoordinatorEventMapper } from '../src/runtime/executors/pi-event-mapper.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore, SqliteAssistantEventRepository, SqliteAssistantBindingRepository, SqliteAssistantPageStateRepository, SqliteAssistantCommandRepository } from '../src/storage/sqlite-assistant-store.js';

const raw = (value: object) => value as AgentSessionEvent;
const makeMapper = () => new PiCoordinatorEventMapper({ assistantSessionId: 'session-a', piSessionId: 'pi-a', sourceInstanceId: 'failure-test' });

function outcome(mapper: PiCoordinatorEventMapper, stopReason: string, errorMessage?: string) {
  mapper.map(raw({ type: 'message_end', message: { role: 'assistant', timestamp: Date.now(), stopReason, errorMessage } }));
  return mapper.map(raw({ type: 'agent_settled' }));
}

test('Pi 最终错误经公共事件与同事务回执保存，重开仍关联原会话和原运行', () => {
  const root = mkdtempSync(join(tmpdir(), 'multivac-failure-chain-'));
  const database = join(root, 'test.sqlite');
  let store = new SqliteAssistantStore(database);
  try {
    for (const suffix of ['a', 'b']) store.insertIfAbsent({ assistantSessionId: `session-${suffix}`, piSessionId: `pi-${suffix}`, piSessionPath: join(root, `${suffix}.jsonl`), updatedAt: '2026-10-01T00:00:00.000Z' });
    let commandId = 'failed-run';
    const feed = new AssistantEventStream();
    const published: AssistantPublicEvent[] = [];
    feed.subscribe(event => published.push(event));
    const projector = new AssistantEventProjector({ adapter: new FakeCoordinatorAdapter(), eventRepository: new SqliteAssistantEventRepository(store), eventStream: feed, assistantSessionId: 'session-a', currentPromptCommandId: () => commandId });
    const mapper = makeMapper();
    const begin = (id: string) => {
      commandId = id;
      store.createAccepted({ commandId, assistantSessionId: 'session-a', kind: 'send', payloadFingerprint: id, piSessionId: 'pi-a' });
      store.markHandedToPi(commandId, 'prompt');
      projector.project(mapper.map(raw({ type: 'agent_start' }))!);
    };
    begin('failed-run');
    projector.project(outcome(mapper, 'error', 'HTTP 401: invalid API key sk-testprivatekey')!);
    const failed = published.at(-1);
    assert.equal(failed?.type, 'assistant.run.failed');
    assert.equal(failed?.commandId, 'failed-run');
    assert.equal(failed?.assistantSessionId, 'session-a');
    assert.equal(store.getCommand(commandId)?.error?.message, 'HTTP 401: invalid API key [已隐藏凭据]');
    store.reconcile(commandId, 'failed', undefined, 'user-entry-failed');
    assert.equal(store.getCommand(commandId)?.error?.code, 'MODEL_REQUEST_FAILED');
    // 后续成功不能覆盖前一次失败的原因。
    begin('successful-run');
    projector.project(outcome(mapper, 'stop')!);
    begin('cancelled-run');
    mapper.markAbortRequested();
    projector.project(outcome(mapper, 'error', '请求中止 sk-cancelprivate')!);
    begin('missing-reason-run');
    projector.project(outcome(mapper, 'error')!);
    const wrongSession = { ...outcome(mapper, 'error', '不属于本会话'), assistantSessionId: 'session-b' } as CoordinatorAdapterEvent;
    assert.equal(projector.project(wrongSession), null);
    assert.equal(JSON.stringify(store.listAfter('0')).includes('sk-testprivatekey'), false);
    store.close();
    store = new SqliteAssistantStore(database);
    const traces = store.runTraceProjections('session-a', 50);
    assert.equal(traces.find(trace => trace.commandId === 'failed-run')?.error?.message, 'HTTP 401: invalid API key [已隐藏凭据]');
    assert.equal(traces.find(trace => trace.commandId === 'successful-run')?.error, undefined);
    assert.equal(traces.find(trace => trace.commandId === 'cancelled-run')?.status, 'cancelled');
    assert.equal(traces.find(trace => trace.commandId === 'cancelled-run')?.error, undefined);
    assert.equal(traces.find(trace => trace.commandId === 'missing-reason-run')?.error, undefined);
    assert.deepEqual(store.runTraceProjections('session-b', 50), []);
    assert.equal(store.listCommandAnchors('session-a').find(anchor => anchor.commandId === 'failed-run')?.piEntryId, 'user-entry-failed');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('重试耗尽采用 finalError；重试成功、工具中间失败与压缩失败不遗留最终错误', () => {
  const mapper = makeMapper();
  mapper.map(raw({ type: 'agent_start' }));
  mapper.map(raw({ type: 'message_end', message: { role: 'assistant', timestamp: 1, stopReason: 'error', errorMessage: '第一次网络错误' } }));
  mapper.map(raw({ type: 'auto_retry_end', success: false, attempt: 2, finalError: 'ETIMEDOUT: 最后一次请求超时' }));
  mapper.map(raw({ type: 'agent_settled' }));
  assert.equal(mapper.getLastRunResult()?.error?.message, 'ETIMEDOUT: 最后一次请求超时');
  mapper.map(raw({ type: 'agent_start' }));
  mapper.map(raw({ type: 'message_end', message: { role: 'assistant', timestamp: 2, stopReason: 'error', errorMessage: '可恢复错误' } }));
  mapper.map(raw({ type: 'tool_execution_end', toolName: 'read', toolCallId: 't', isError: true, result: { content: [{ type: 'text', text: 'private tool output' }] } }));
  mapper.map(raw({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, errorMessage: 'private compaction output' }));
  mapper.map(raw({ type: 'auto_retry_end', success: true, attempt: 1 }));
  const settled = mapper.map(raw({ type: 'agent_settled' }));
  assert.equal(settled?.type, 'coordinator.run.completed');
  assert.equal(mapper.getLastRunResult()?.error, undefined);
  mapper.resetRunResult();
  assert.equal(mapper.getLastRunResult(), undefined);
});

test('prompt 在 agent_start 前异常时，handoff 和命令对账足以保存失败轨迹', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    store.insertIfAbsent({ assistantSessionId: 'session-a', piSessionId: 'pi-a', piSessionPath: '/test/pi.jsonl', updatedAt: '2026-10-01T00:00:00.000Z' });
    store.createAccepted({ commandId: 'early-failure', assistantSessionId: 'session-a', kind: 'send', payloadFingerprint: 'early', piSessionId: 'pi-a' });
    store.markHandedToPi('early-failure', 'prompt');
    store.reconcile('early-failure', 'failed', { code: 'RUNTIME_OPERATION_FAILED', message: '工具租约核对失败' });
    assert.equal(store.runTraceProjections('session-a', 50)[0]?.error?.message, '工具租约核对失败');
    assert.equal(store.runTraceProjections('session-a', 50)[0]?.status, 'failed');
  } finally { store.close(); }
});

test('历史页按准确命令身份补回超过最近窗口的失败，不跨会话读取', () => {
  const store = new SqliteAssistantStore(':memory:');
  try {
    for (const suffix of ['a', 'b']) store.insertIfAbsent({ assistantSessionId: `session-${suffix}`, piSessionId: `pi-${suffix}`, piSessionPath: `/test/${suffix}.jsonl`, updatedAt: '2026-10-01T00:00:00.000Z' });
    for (let index = 0; index < 55; index += 1) {
      const id = `history-${index}`;
      store.createAccepted({ commandId: id, assistantSessionId: 'session-a', kind: 'send', payloadFingerprint: id, piSessionId: 'pi-a' });
      store.markHandedToPi(id, 'prompt');
      store.reconcile(id, index === 0 ? 'failed' : 'succeeded', index === 0 ? { code: 'MODEL_REQUEST_FAILED', message: '早期请求网络中断' } : undefined, `user-${index}`);
    }
    assert.equal(store.runTraceProjections('session-a', 50).some(trace => trace.commandId === 'history-0'), false);
    assert.equal(store.runTraceProjections('session-a', 50, ['history-0']).find(trace => trace.commandId === 'history-0')?.error?.message, '早期请求网络中断');
    assert.deepEqual(store.runTraceProjections('session-b', 50, ['history-0']), []);
  } finally { store.close(); }
});

test('没有正文的模型失败锚在本轮可见用户消息，发送前抛错不借用旧轮锚点', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const adapter = new FakeCoordinatorAdapter({ promptScenario: 'failureWithReason' });
  const readBranch = adapter.readActiveBranch.bind(adapter);
  // 模拟 Pi 的空错误 entry：它存在于分支叶节点，却不会进入公开消息历史。
  adapter.readActiveBranch = (id) => {
    const snapshot = readBranch(id);
    return snapshot.ok ? { ok: true, value: { ...snapshot.value, leafEntryId: 'invisible-error-entry' } } : snapshot;
  };
  const feed = new AssistantEventStream();
  const events = new SqliteAssistantEventRepository(store);
  const receipts = new SqliteAssistantCommandRepository(store);
  let projector: AssistantEventProjector;
  const session = new AssistantSessionService({
    adapter, bindingRepository: new SqliteAssistantBindingRepository(store), pageStateRepository: new SqliteAssistantPageStateRepository(store), eventRepository: events, commandRepository: receipts,
    assistantSessionId: 'session-a', kind: 'work', resolveWorkingDirectory: () => ({ kind: 'session-temp', path: '/test/work' }),
    runtimeConfig: { systemPrompt: '测试会话', authorizedContext: [], model: { provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 } },
    onInitialized: () => projector.start(),
  });
  const commands = new AssistantTurnCommandService({ sessionService: session, adapter, commandRepository: receipts, eventStream: feed, assistantSessionId: 'session-a' });
  projector = new AssistantEventProjector({ adapter, eventRepository: events, eventStream: feed, assistantSessionId: 'session-a', currentPromptCommandId: () => commands.currentPromptCommandId() });
  try {
    const failed = await commands.send({ commandId: 'empty-model-failure', assistantSessionId: 'session-a', text: '测试认证失败', contextRefs: [] });
    assert.equal(failed.terminalOutcome, 'failed');
    assert.equal(failed.piEntryId, 'entry-prompt-1-user');
    assert.match(failed.error?.message ?? '', /HTTP 401/);
    adapter.prompt = async () => { throw new Error('内部执行抛错，用户消息尚未写入'); };
    const early = await commands.send({ commandId: 'no-new-message', assistantSessionId: 'session-a', text: '尚未写入的新请求', contextRefs: [] });
    assert.equal(early.terminalOutcome, 'failed');
    assert.equal(early.piEntryId, null);
    assert.match(early.error?.message ?? '', /内部执行抛错/);
    adapter.prompt = () => { throw new Error('同步执行异常'); };
    const synchronous = await commands.send({ commandId: 'sync-error', assistantSessionId: 'session-a', text: '同步失败请求', contextRefs: [] });
    assert.equal(synchronous.terminalOutcome, 'failed');
    assert.equal(synchronous.piEntryId, null);
    assert.equal(synchronous.error?.message, '同步执行异常');
    assert.equal(commands.currentPromptCommandId(), null);
  } finally { projector.close(); adapter.dispose(); store.close(); }
});
