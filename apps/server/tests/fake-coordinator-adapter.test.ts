import assert from 'node:assert/strict';
import test from 'node:test';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { COORDINATOR_TOOL_ALLOWLIST } from '../src/runtime/executors/coordinator-tools.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [{ referenceId: 'project', label: '项目摘要', content: '只读内容' }],
  model: { provider: 'fake', modelId: 'fake-model', thinkingLevel: 'medium' },
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
  compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

test('显式 streaming fixture 在失败/取消终态之前保存校准历史或明确省略，不追加剩余正文', async () => {
  for (const outcome of ['failed', 'cancelled'] as const) {
    for (const terminalHistory of ['persist', 'omit'] as const) {
      const adapter = new FakeCoordinatorAdapter({ promptScenario: outcome === 'failed' ? 'failure' : 'success' });
      const sessionId = `stream-${outcome}-${terminalHistory}`;
      await adapter.createSession({ assistantSessionId: sessionId, config });
      const deltas: string[] = [];
      let terminalHistoryCount = -1;
      adapter.subscribe(sessionId, (event) => {
        if (event.type === 'coordinator.message.delta' && event.channel === 'text') deltas.push(event.delta);
        if (event.type === `coordinator.run.${outcome}`) {
          const snapshot = adapter.readActiveBranch(sessionId);
          terminalHistoryCount = snapshot.ok
            ? snapshot.value.messages.filter((message) => message.runtimeMessageId === 'assistant:prompt-1').length : -1;
        }
      });
      adapter.armPromptCompletionBarrier(true, { terminalHistory });
      const run = adapter.prompt(sessionId, '验证部分正文终态');
      await adapter.waitForPromptCompletionBarrierEntry();
      assert.equal(deltas.length, 1);
      if (outcome === 'cancelled') await adapter.abort(sessionId);
      adapter.releasePromptCompletionBarrier();
      const result = await run;
      assert.equal(result.ok ? result.value.status : 'adapter-error', outcome);
      assert.equal(terminalHistoryCount, terminalHistory === 'persist' ? 1 : 0);
      assert.equal(deltas.length, 1);
      const snapshot = adapter.readActiveBranch(sessionId);
      const message = snapshot.ok ? snapshot.value.messages.find((item) => item.runtimeMessageId === 'assistant:prompt-1') : undefined;
      if (terminalHistory === 'persist') {
        assert.ok(message?.text.startsWith(deltas[0]!));
        assert.notEqual(message?.text, deltas[0]);
      } else assert.equal(message, undefined);
      adapter.dispose();
    }
  }
});

test('显式 streaming fixture 的 followUp 产生独立正文身份，按顺序持久化且只运行一次 prompt', async () => {
  const adapter = new FakeCoordinatorAdapter();
  await adapter.createSession({ assistantSessionId: 'stream-follow-up', config });
  const ids: string[] = [];
  adapter.subscribe('stream-follow-up', (event) => {
    if (event.type === 'coordinator.message.delta') ids.push(event.messageId);
  });
  adapter.armPromptCompletionBarrier(true, { simulateFollowUps: true });
  const run = adapter.prompt('stream-follow-up', '首条请求');
  await adapter.waitForPromptCompletionBarrierEntry();
  await adapter.followUp('stream-follow-up', '真正的后续请求');
  adapter.releasePromptCompletionBarrier();
  await run;
  const snapshot = adapter.readActiveBranch('stream-follow-up');
  assert.deepEqual(snapshot.ok ? snapshot.value.messages.map((message) => message.text) : [], [
    '首条请求', 'Fake Multivac 已处理当前消息。', '真正的后续请求', 'Fake followUp 已处理：真正的后续请求',
  ]);
  assert.deepEqual([...new Set(ids)], ['assistant:prompt-1', 'assistant:prompt-1:followUp-1']);
  assert.equal(adapter.calls.filter((call) => call.method === 'prompt').length, 1);
  adapter.dispose();
});

test('取消旧 prompt 后新 Turn 挂起时，旧延迟不得发出新 Turn 的终态', async () => {
  const adapter = new FakeCoordinatorAdapter({ promptDelayMs: 30 });
  await adapter.createSession({ assistantSessionId: 'overlap', config });
  const events: string[] = [];
  let started!: () => void;
  const entry = new Promise<void>((resolve) => { started = resolve; });
  adapter.subscribe('overlap', (event) => {
    events.push(event.type);
    if (event.type === 'coordinator.run.started') started();
  });
  const old = adapter.prompt('overlap', 'old');
  await entry;
  await adapter.abort('overlap');
  adapter.armPromptCompletionBarrier();
  const fresh = adapter.prompt('overlap', 'fresh');
  await adapter.waitForPromptCompletionBarrierEntry();
  assert.deepEqual(await old, { ok: true, value: { status: 'cancelled' } });
  assert.equal(adapter.isStreaming('overlap').ok, true);
  assert.equal(events.filter((type) => type === 'coordinator.run.completed').length, 0);
  adapter.releasePromptCompletionBarrier();
  const result = await fresh;
  assert.equal(result.ok && result.value.status, 'completed');
  assert.equal(events.filter((type) => type === 'coordinator.run.completed').length, 1);
});

test('FakeCoordinatorAdapter 离线创建会话并确定性记录调用和事件', async () => {
  const adapter = new FakeCoordinatorAdapter();
  const created = await adapter.createSession({
    assistantSessionId: 'assistant-1',
    config,
    initialEventSequence: 10,
  });

  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.value.activeToolNames, [...COORDINATOR_TOOL_ALLOWLIST]);
  assert.equal(created.value.binding.piSessionId, 'pi-fake-assistant-1');
  assert.deepEqual(created.value.model, {
    provider: 'fake',
    modelId: 'fake-model',
    thinkingLevel: 'medium',
  });

  const events: string[] = [];
  const subscription = adapter.subscribe('assistant-1', (event) => {
    events.push(`${event.sequence}:${event.type}`);
  });
  assert.equal(subscription.ok, true);

  const run = await adapter.prompt('assistant-1', '整理当前工作');
  assert.equal(run.ok, true);
  if (!run.ok) return;
  assert.equal(run.value.status, 'completed');
  assert.equal(run.value.usage?.totalTokens, 170);
  assert.deepEqual(events, [
    '11:coordinator.run.started',
    '12:coordinator.message.started',
    '13:coordinator.message.delta',
    '14:coordinator.tool.started',
    '15:coordinator.tool.ended',
    '16:coordinator.run.completed',
  ]);

  assert.deepEqual(
    adapter.calls.map((call) => call.method),
    ['createSession', 'subscribe', 'prompt'],
  );
});

test('FakeCoordinatorAdapter 支持继续、指令、取消和模型状态', async () => {
  const adapter = new FakeCoordinatorAdapter({ promptScenario: 'failure' });
  const binding = {
    assistantSessionId: 'assistant-2',
    piSessionId: 'pi-existing',
    piSessionPath: '/existing/pi.jsonl',
    updatedAt: '2026-09-14T07:00:00.000Z',
  };
  const continued = await adapter.continueSession({ binding, config });
  assert.equal(continued.ok, true);

  assert.deepEqual(await adapter.steer('assistant-2', '立即关注风险'), {
    ok: true,
    value: { accepted: true },
  });
  assert.deepEqual(await adapter.followUp('assistant-2', '完成后给出总结'), {
    ok: true,
    value: { accepted: true },
  });

  const model = await adapter.setModel('assistant-2', {
    provider: 'fake-2',
    modelId: 'model-2',
    thinkingLevel: 'high',
  });
  assert.deepEqual(model, {
    ok: true,
    value: {
      model: { provider: 'fake-2', modelId: 'model-2', thinkingLevel: 'high' },
      diagnostics: [],
    },
  });
  const thinking = await adapter.setThinkingLevel('assistant-2', 'low');
  assert.deepEqual(thinking, {
    ok: true,
    value: {
      model: { provider: 'fake-2', modelId: 'model-2', thinkingLevel: 'low' },
      diagnostics: [],
    },
  });

  const events: string[] = [];
  adapter.subscribe('assistant-2', (event) => events.push(event.type));
  const run = await adapter.prompt('assistant-2', '触发失败场景');
  assert.deepEqual(run, { ok: true, value: { status: 'failed' } });
  assert.deepEqual(await adapter.abort('assistant-2'), { ok: true, value: { accepted: true } });
  assert.deepEqual(events, ['coordinator.run.failed']);
});

test('FakeCoordinatorAdapter 对未激活会话返回稳定错误', async () => {
  const adapter = new FakeCoordinatorAdapter();
  const result = await adapter.prompt('missing', '不会执行');

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'SESSION_NOT_ACTIVE', message: 'Multivac 会话未激活。' },
  });
});

test('FakeCoordinatorAdapter 可接续最近会话并读取确定性历史', async () => {
  const adapter = new FakeCoordinatorAdapter({
    history: [{
      id: 'ignored',
      piSessionId: 'ignored',
      piEntryId: 'entry-1',
      role: 'assistant',
      text: '已有历史',
      createdAt: '2026-09-14T08:00:00.000Z',
    }],
  });

  const initialized = await adapter.continueRecentSession({
    assistantSessionId: 'assistant-history',
    config,
  });
  assert.equal(initialized.ok, true);
  assert.deepEqual(adapter.readActiveBranch('assistant-history'), {
    ok: true,
    value: {
      piSessionId: 'pi-fake-assistant-history',
      leafEntryId: 'entry-1',
      messages: [{
        id: 'pi-fake-assistant-history:entry-1',
        piSessionId: 'pi-fake-assistant-history',
        piEntryId: 'entry-1',
        role: 'assistant',
        text: '已有历史',
        createdAt: '2026-09-14T08:00:00.000Z',
      }],
    },
  });
  assert.deepEqual(adapter.calls.map((call) => call.method), [
    'continueRecentSession',
    'readActiveBranch',
  ]);
});

test('FakeCoordinatorAdapter 的重试压缩场景仍以完整完成事件收敛', async () => {
  const adapter = new FakeCoordinatorAdapter({ promptScenario: 'retryAndCompaction' });
  await adapter.createSession({ assistantSessionId: 'assistant-3', config });
  const events: string[] = [];
  adapter.subscribe('assistant-3', (event) => events.push(event.type));

  const result = await adapter.prompt('assistant-3', '触发重试和压缩');

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, 'completed');
  assert.deepEqual(events, [
    'coordinator.run.started',
    'coordinator.retry.started',
    'coordinator.retry.ended',
    'coordinator.compaction.started',
    'coordinator.compaction.ended',
    'coordinator.message.started',
    'coordinator.message.delta',
    'coordinator.tool.started',
    'coordinator.tool.ended',
    'coordinator.run.completed',
  ]);
});

test('FakeCoordinatorAdapter 的工具错误不决定 run 终态，最终成功和失败分别收敛', async () => {
  for (const [scenario, expectedStatus, expectedAssistantMessages] of [
    ['toolFailureThenSuccess', 'completed', 1],
    ['toolFailureThenFailure', 'failed', 0],
  ] as const) {
    const adapter = new FakeCoordinatorAdapter({ promptScenario: scenario });
    await adapter.createSession({ assistantSessionId: `assistant-${scenario}`, config });
    const events: string[] = [];
    adapter.subscribe(`assistant-${scenario}`, (event) => events.push(event.type));

    const result = await adapter.prompt(`assistant-${scenario}`, scenario);

    assert.equal(result.ok ? result.value.status : 'adapter-error', expectedStatus);
    assert.deepEqual(events.slice(0, 3), [
      'coordinator.run.started',
      'coordinator.tool.started',
      'coordinator.tool.ended',
    ]);
    assert.equal(events.at(-1), `coordinator.run.${expectedStatus}`);
    const snapshot = adapter.readActiveBranch(`assistant-${scenario}`);
    assert.equal(
      snapshot.ok ? snapshot.value.messages.filter((message) => message.role === 'assistant').length : -1,
      expectedAssistantMessages,
    );
  }
});

test('FakeCoordinatorAdapter 的压缩失败只作为中间事件，最终成功和失败分别收敛', async () => {
  for (const [scenario, expectedStatus, expectedAssistantMessages] of [
    ['compactionFailureThenSuccess', 'completed', 1],
    ['compactionFailureThenFailure', 'failed', 0],
  ] as const) {
    const adapter = new FakeCoordinatorAdapter({ promptScenario: scenario });
    await adapter.createSession({ assistantSessionId: `assistant-${scenario}`, config });
    const events: string[] = [];
    adapter.subscribe(`assistant-${scenario}`, (event) => events.push(event.type));

    const result = await adapter.prompt(`assistant-${scenario}`, scenario);

    assert.equal(result.ok ? result.value.status : 'adapter-error', expectedStatus);
    assert.deepEqual(events.slice(0, 3), [
      'coordinator.run.started',
      'coordinator.compaction.started',
      'coordinator.compaction.ended',
    ]);
    assert.equal(events.at(-1), `coordinator.run.${expectedStatus}`);
    const snapshot = adapter.readActiveBranch(`assistant-${scenario}`);
    assert.equal(
      snapshot.ok ? snapshot.value.messages.filter((message) => message.role === 'assistant').length : -1,
      expectedAssistantMessages,
    );
  }
});

test('FakeCoordinatorAdapter completion barrier 以事件握手固定 processing 窗口', async () => {
  const adapter = new FakeCoordinatorAdapter();
  await adapter.createSession({ assistantSessionId: 'assistant-barrier', config });
  const events: string[] = [];
  adapter.subscribe('assistant-barrier', (event) => events.push(event.type));
  adapter.armPromptCompletionBarrier();

  const run = adapter.prompt('assistant-barrier', '等待测试释放终态');
  await adapter.waitForPromptCompletionBarrierEntry();

  assert.deepEqual(events, ['coordinator.run.started']);
  assert.deepEqual(adapter.isStreaming('assistant-barrier'), { ok: true, value: true });

  adapter.releasePromptCompletionBarrier();
  assert.deepEqual(await run, {
    ok: true,
    value: {
      status: 'completed',
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
        totalTokens: 170,
        cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
      },
    },
  });
  assert.equal(events.at(-1), 'coordinator.run.completed');
});

test('Fake reset 等待旧 generation 退出，释放旧任务后不污染下一用例历史', async () => {
  const adapter = new FakeCoordinatorAdapter({
    history: [{
      id: 'fixture',
      piSessionId: 'fixture',
      piEntryId: 'entry-base',
      role: 'assistant',
      text: '基线历史',
      createdAt: '2026-09-16T08:00:00.000Z',
    }],
  });
  await adapter.createSession({ assistantSessionId: 'assistant-reset', config });
  adapter.armPromptCompletionBarrier();
  const oldRun = adapter.prompt('assistant-reset', '旧 generation 消息');
  await adapter.waitForPromptCompletionBarrierEntry();

  await adapter.resetForTest();
  assert.deepEqual(await oldRun, { ok: true, value: { status: 'cancelled' } });
  const afterReset = adapter.readActiveBranch('assistant-reset');
  assert.deepEqual(afterReset.ok ? afterReset.value.messages.map((message) => message.text) : [], [
    '基线历史',
  ]);

  const nextRun = await adapter.prompt('assistant-reset', '新 generation 消息');
  assert.equal(nextRun.ok ? nextRun.value.status : 'adapter-error', 'completed');
  const final = adapter.readActiveBranch('assistant-reset');
  assert.deepEqual(final.ok ? final.value.messages.map((message) => message.text) : [], [
    '基线历史',
    '新 generation 消息',
    'Fake Multivac 已处理当前消息。',
  ]);
});
