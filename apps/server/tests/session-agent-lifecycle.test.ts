import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CoordinatorRuntimeConfig, SendAssistantMessageCommand } from '@multivac/contracts';
import type { AssistantAgentExecution } from '../src/modules/sessions/assistant-turn.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { FakeCoordinatorAdapter, type FakeCoordinatorAdapterOptions } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore, SqliteAssistantCommandRepository, SqliteAssistantEventRepository } from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = { systemPrompt: '原有系统与授权边界。', authorizedContext: [], model: { provider: 'fake', modelId: 'base', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
const execution: AssistantAgentExecution = { executor: { agentId: 'reviewer', revision: 2, name: '受理时名称', modelProfileId: 'target', modelName: '模型 B', provider: 'fake', modelId: 'target', thinkingLevel: 'high' }, model: { provider: 'fake', modelId: 'target', thinkingLevel: 'high' }, instructions: '先列风险，保留原有约束。' };
const send = (commandId: string, fields: Partial<SendAssistantMessageCommand> = {}): SendAssistantMessageCommand => ({ commandId, assistantSessionId: 'work', text: '审查当前改动', contextRefs: [], agentId: 'reviewer', ...fields });

async function fixture(options: FakeCoordinatorAdapterOptions = {}, supported = true) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agent-lifecycle-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({ ...options, seedsHistory: () => false });
  let current: AssistantAgentExecution | null = structuredClone(execution);
  const session = new AssistantSessionService({ assistantSessionId: 'work', kind: 'work', adapter, runtimeConfig: config, resolveWorkingDirectory: () => ({ kind: 'session-temp', path: root }), bindingRepository: store.bindings, pageStateRepository: store });
  await session.initialize();
  const repository = new SqliteAssistantCommandRepository(store);
  const commands = new AssistantTurnCommandService({ assistantSessionId: 'work', sessionService: session, adapter, commandRepository: repository, eventStream: new AssistantEventStream(), ...(supported ? { resolveAgentExecution: async (id: string) => { if (id !== current?.executor.agentId) throw new Error('智能体不存在或不可用。'); return structuredClone(current); } } : {}) });
  return { store, adapter, commands, change(next: AssistantAgentExecution | null) { current = next; }, async close() { adapter.dispose(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const scenario of ['success', 'failure', 'cancelled'] as const) test(`${scenario} 后临时配置不写永久模型，下一轮普通正文 @ 不调用智能体`, async () => {
  const state = await fixture({ promptScenario: scenario });
  try {
    const receipt = await state.commands.send(send(`selected-${scenario}`));
    assert.deepEqual(receipt.executor, execution.executor);
    assert.equal('agentExecution' in receipt, false);
    assert.equal(receipt.terminalOutcome, scenario === 'success' ? 'succeeded' : scenario === 'failure' ? 'failed' : 'cancelled');
    const actual = state.adapter.readModelSelection('work');
    assert.ok(actual.ok); if (actual.ok) assert.equal(actual.value.model.modelId, 'base');
    const ordinary = await state.commands.send(send(`ordinary-${scenario}`, { agentId: undefined, text: 'user@example.com 和 @reviewer 都是正文' }));
    assert.equal(ordinary.executor, undefined);
    assert.equal(state.adapter.calls.filter(call => call.method === 'turnExecution').length, 1);
    assert.equal(state.adapter.calls.filter(call => call.method === 'setModel').length, 0);
  } finally { await state.close(); }
});

test('受理后修改或删除不改本轮；追加锁定执行者；重放只读返回原快照且换身份冲突', async () => {
  const state = await fixture();
  state.adapter.armPromptCompletionBarrier();
  try {
    const original = send('original');
    const running = state.commands.send(original);
    await state.adapter.waitForPromptCompletionBarrierEntry();
    state.change(null);
    const queued = await state.commands.send(send('queued', { agentId: undefined, streamingBehavior: 'followUp', text: '继续补充' }));
    assert.deepEqual(queued.executor, execution.executor);
    await assert.rejects(state.commands.send(send('switch', { agentId: 'other', streamingBehavior: 'steer' })), /不能更换智能体/);
    await assert.rejects(state.commands.send({ ...original, agentId: 'other' }), /commandId/);
    state.adapter.releasePromptCompletionBarrier();
    const receipt = await running;
    assert.deepEqual((await state.commands.send(original)).executor, receipt.executor);
    assert.deepEqual(state.commands.get('original').receipt?.executor, execution.executor);
    assert.equal(state.adapter.calls.filter(call => call.method === 'turnExecution').length, 1);
    await assert.rejects(state.commands.send(send('deleted')), /智能体不存在/);
    assert.equal(state.commands.get('deleted').status, 'unknown');
  } finally { state.adapter.releasePromptCompletionBarrier(); await state.close(); }
});

test('prompt 抛错与用户停止都恢复配置，不会留下活动执行者', async () => {
  const state = await fixture();
  try {
    const prompt = state.adapter.prompt.bind(state.adapter);
    state.adapter.prompt = async () => { throw new Error('injected prompt error'); };
    assert.equal((await state.commands.send(send('throws'))).terminalOutcome, 'failed');
    assert.equal(state.commands.currentPromptCommandId(), null);
    const restored = state.adapter.readModelSelection('work');
    if (restored.ok) assert.equal(restored.value.model.modelId, 'base'); else assert.fail();
    state.adapter.prompt = prompt;
    state.adapter.armPromptCompletionBarrier();
    const running = state.commands.send(send('stopped'));
    await state.adapter.waitForPromptCompletionBarrierEntry();
    await state.commands.cancel({ commandId: 'stop', assistantSessionId: 'work' });
    state.adapter.releasePromptCompletionBarrier();
    assert.equal((await running).terminalOutcome, 'cancelled');
    const actual = state.adapter.readModelSelection('work');
    if (actual.ok) assert.equal(actual.value.model.modelId, 'base'); else assert.fail();
    assert.equal(state.commands.currentPromptCommandId(), null);
  } finally { state.adapter.releasePromptCompletionBarrier(); await state.close(); }
});

test('未注入智能体能力的会话明确拒绝，纯标记同样拒绝且不受理', async () => {
  const unsupported = await fixture({}, false);
  const supported = await fixture();
  try {
    await assert.rejects(unsupported.commands.send(send('unsupported')), /不支持指定本轮智能体/);
    await assert.rejects(supported.commands.send(send('marker-only', { text: '  ' })), /正文不能为空/);
    assert.equal(unsupported.commands.get('unsupported').status, 'unknown');
    assert.equal(supported.commands.get('marker-only').status, 'unknown');
  } finally { await unsupported.close(); await supported.close(); }
});
