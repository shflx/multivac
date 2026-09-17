import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type {
  AssistantPublicEvent,
  CoordinatorRuntimeConfig,
  SendAssistantMessageCommand,
} from '@multivac/contracts';
import { AssistantEventProjector } from '../src/application/assistant-event-projector.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import {
  AssistantTurnCommandService,
  AssistantTurnCommandServiceError,
} from '../src/application/assistant-turn-command-service.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantCommandRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac。',
  authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function waitForEvents(
  stream: AssistantEventStream,
  count: number,
  predicate: (event: AssistantPublicEvent) => boolean,
): Promise<AssistantPublicEvent[]> {
  return new Promise((resolve) => {
    const matched: AssistantPublicEvent[] = [];
    const unsubscribe = stream.subscribe((event) => {
      if (!predicate(event)) return;
      matched.push(event);
      if (matched.length === count) {
        unsubscribe();
        resolve(matched);
      }
    });
  });
}

async function harness(
  promptDelayMs = 0,
  promptBarrier?: Promise<void>,
  barriers: {
    promptCompletionBarrier?: Promise<void>;
    promptReturnBarrier?: Promise<void>;
    abortBarrier?: Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-turn-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({
    promptDelayMs,
    promptBarrier,
    ...barriers,
  });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const eventStream = new AssistantEventStream();
  const sessionService = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    eventRepository,
    runtimeConfig: config,
  });
  await sessionService.initialize();
  const commandService = new AssistantTurnCommandService({
    sessionService,
    adapter,
    commandRepository,
    eventStream,
  });
  const projector = new AssistantEventProjector({
    adapter,
    eventRepository,
    eventStream,
    assistantSessionId: 'global-coordinator',
    currentPromptCommandId: () => commandService.currentPromptCommandId(),
  });
  projector.start();
  return {
    root,
    store,
    adapter,
    commandRepository,
    eventRepository,
    eventStream,
    commandService,
    projector,
    async close() {
      projector.close();
      adapter.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function send(commandId: string, text: string, streamingBehavior?: 'steer' | 'followUp'):
SendAssistantMessageCommand {
  return {
    commandId,
    assistantSessionId: 'global-coordinator',
    text,
    contextRefs: [],
    ...(streamingBehavior ? { streamingBehavior } : {}),
  };
}

test('同 commandId 并发同 payload 单飞，不同 fingerprint 在 barrier 前立即冲突', async () => {
  let releasePrompt!: () => void;
  const promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const target = await harness(0, promptBarrier);
  try {
    const command = send('singleflight-1', '  保留原始正文\n  ');
    const firstPromise = target.commandService.send(command);
    const secondPromise = target.commandService.send(command);
    await assert.rejects(
      target.commandService.send(send('singleflight-1', '不同正文')),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
    await assert.rejects(
      target.commandService.cancel({
        commandId: 'singleflight-1', assistantSessionId: 'global-coordinator',
      }),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
    await assert.rejects(
      target.commandService.send({ ...command, assistantSessionId: 'other-session' }),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
    assert.equal(target.commandService.get('singleflight-1').status, 'handed_to_pi');

    releasePrompt();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.deepEqual(first, second);
    assert.equal(first.terminalOutcome, 'succeeded');
    assert.ok(first.piEntryId?.includes('assistant'));
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);

    const inspection = new DatabaseSync(join(target.root, 'data.sqlite'), { readOnly: true });
    const persisted = JSON.stringify({
      commands: inspection.prepare('SELECT * FROM assistant_command_receipt').all(),
      events: inspection.prepare('SELECT * FROM assistant_event_projection').all(),
    });
    inspection.close();
    assert.equal(persisted.includes(command.text), false);
    assert.equal(
      target.adapter.calls.find((call) => call.method === 'prompt' && 'text' in call)?.text,
      command.text,
    );
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
  } finally {
    releasePrompt();
    await target.close();
  }
});

test('已完成 commandId 的 behavior、session 与命令 kind 变化稳定冲突', async () => {
  const target = await harness();
  try {
    await target.commandService.send(send('persisted-conflict', '原始正文'));
    for (const conflicting of [
      () => target.commandService.send(send('persisted-conflict', '原始正文', 'followUp')),
      () => target.commandService.send({
        ...send('persisted-conflict', '原始正文'), assistantSessionId: 'other-session',
      }),
      () => target.commandService.cancel({
        commandId: 'persisted-conflict', assistantSessionId: 'global-coordinator',
      }),
    ]) {
      await assert.rejects(
        conflicting(),
        (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
          error.code === 'COMMAND_ID_CONFLICT',
      );
    }
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
  } finally {
    await target.close();
  }
});

test('空闲只允许 prompt，流式必须明确 steer/followUp，取消只调用 abort', async () => {
  const promptCompletion = deferred<void>();
  const target = await harness(0, undefined, {
    promptCompletionBarrier: promptCompletion.promise,
  });
  try {
    const idleMismatch = await target.commandService.send(send('idle-steer', '调整', 'steer'));
    assert.equal(idleMismatch.terminalOutcome, 'rejected');
    assert.equal(target.adapter.calls.some((call) => call.method === 'steer'), false);

    const processing = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.processing',
    );
    const prompt = target.commandService.send(send('prompt-running', '启动慢任务'));
    await processing;
    assert.deepEqual(target.adapter.isStreaming('global-coordinator'), { ok: true, value: true });

    const missingBehavior = await target.commandService.send(send('missing-behavior', '运行中消息'));
    assert.equal(missingBehavior.terminalOutcome, 'rejected');
    const steer = await target.commandService.send(send('steer-1', '立即调整', 'steer'));
    const followUp = await target.commandService.send(send('follow-1', '完成后继续', 'followUp'));
    assert.equal(steer.terminalOutcome, 'accepted');
    assert.equal(followUp.terminalOutcome, 'accepted');

    const cancelled = await target.commandService.cancel({
      commandId: 'cancel-1', assistantSessionId: 'global-coordinator',
    });
    assert.equal(cancelled.terminalOutcome, 'accepted');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);
    promptCompletion.resolve();
    assert.equal((await prompt).terminalOutcome, 'cancelled');
  } finally {
    promptCompletion.resolve();
    await target.close();
  }
});

test('prompt 已由 Pi terminal 时取消返回 no-active-turn，且不调用 abort 或覆盖 succeeded', async () => {
  const promptReturn = deferred<void>();
  const target = await harness(0, undefined, { promptReturnBarrier: promptReturn.promise });
  try {
    const succeeded = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.succeeded',
    );
    const prompt = target.commandService.send(send('terminal-before-cancel', '先完成再取消'));
    await succeeded;
    assert.equal(target.commandService.get('terminal-before-cancel').receipt?.terminalOutcome, 'succeeded');

    const cancel = await target.commandService.cancel({
      commandId: 'terminal-before-cancel-command',
      assistantSessionId: 'global-coordinator',
    });
    assert.equal(cancel.terminalOutcome, 'rejected');
    assert.equal(cancel.error?.code, 'COMMAND_STATE_MISMATCH');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 0);
    assert.equal(target.commandService.get('terminal-before-cancel').receipt?.terminalOutcome, 'succeeded');

    promptReturn.resolve();
    assert.equal((await prompt).terminalOutcome, 'succeeded');
  } finally {
    promptReturn.resolve();
    await target.close();
  }
});

test('同一活跃 prompt 的重复与不同 commandId 并发取消共享一次 abort 和各自幂等回执', async () => {
  const promptCompletion = deferred<void>();
  const abortBarrier = deferred<void>();
  const target = await harness(0, undefined, {
    promptCompletionBarrier: promptCompletion.promise,
    abortBarrier: abortBarrier.promise,
  });
  try {
    const processing = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.processing',
    );
    const prompt = target.commandService.send(send('cancel-singleflight-prompt', '等待并发取消'));
    await processing;

    const handedCancels = waitForEvents(
      target.eventStream,
      2,
      (event) => event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode === 'abort',
    );
    const repeatedCommand = {
      commandId: 'cancel-singleflight-a',
      assistantSessionId: 'global-coordinator',
    } as const;
    const first = target.commandService.cancel(repeatedCommand);
    const duplicate = target.commandService.cancel(repeatedCommand);
    const distinct = target.commandService.cancel({
      commandId: 'cancel-singleflight-b',
      assistantSessionId: 'global-coordinator',
    });
    await handedCancels;
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);

    abortBarrier.resolve();
    const [firstReceipt, duplicateReceipt, distinctReceipt] = await Promise.all([
      first,
      duplicate,
      distinct,
    ]);
    assert.deepEqual(duplicateReceipt, firstReceipt);
    assert.equal(firstReceipt.terminalOutcome, 'accepted');
    assert.equal(distinctReceipt.terminalOutcome, 'accepted');
    assert.notEqual(distinctReceipt.commandId, firstReceipt.commandId);

    promptCompletion.resolve();
    assert.equal((await prompt).terminalOutcome, 'cancelled');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);

    const events = target.eventRepository.listAfter('0');
    for (const commandId of ['cancel-singleflight-a', 'cancel-singleflight-b']) {
      assert.deepEqual(
        events.filter((event) => event.commandId === commandId).map((event) => event.type),
        [
          'assistant.command.accepted',
          'assistant.command.handed_to_pi',
          'assistant.command.reconciled',
        ],
      );
    }

    const eventCountBeforeReplay = target.eventRepository.listAfter('0').length;
    assert.deepEqual(await target.commandService.cancel(repeatedCommand), firstReceipt);
    assert.equal(target.eventRepository.listAfter('0').length, eventCountBeforeReplay);
    await assert.rejects(
      target.commandService.cancel({
        ...repeatedCommand,
        assistantSessionId: 'other-session',
      }),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);
  } finally {
    abortBarrier.resolve();
    promptCompletion.resolve();
    await target.close();
  }
});

test('cancel 与 prompt terminal 竞争时以 Pi succeeded 事实收敛，不伪造 cancelled', async () => {
  const promptCompletion = deferred<void>();
  const abortBarrier = deferred<void>();
  const target = await harness(0, undefined, {
    promptCompletionBarrier: promptCompletion.promise,
    abortBarrier: abortBarrier.promise,
  });
  try {
    const processing = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.processing',
    );
    const prompt = target.commandService.send(send('cancel-terminal-race', 'Pi 先完成'));
    await processing;

    const cancelHanded = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode === 'abort',
    );
    const cancel = target.commandService.cancel({
      commandId: 'cancel-terminal-race-command',
      assistantSessionId: 'global-coordinator',
    });
    await cancelHanded;

    promptCompletion.resolve();
    const promptReceipt = await prompt;
    assert.equal(promptReceipt.terminalOutcome, 'succeeded');
    abortBarrier.resolve();
    assert.equal((await cancel).terminalOutcome, 'accepted');
    assert.equal(target.commandService.get('cancel-terminal-race').receipt?.terminalOutcome, 'succeeded');
    assert.equal(
      target.eventRepository.listAfter('0').some((event) => event.type === 'assistant.run.cancelled'),
      false,
    );
  } finally {
    promptCompletion.resolve();
    abortBarrier.resolve();
    await target.close();
  }
});

test('安全投影只持久化白名单正文，重复源事件不分配第二个 cursor', async () => {
  const target = await harness();
  try {
    const base = {
      eventId: 'pi-1:99',
      cursor: 'pi-1:99',
      sequence: 99,
      sourceInstanceId: 'same-process',
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-1',
      occurredAt: '2026-09-14T08:00:00.000Z',
    };
    assert.equal(target.projector.project({
      ...base,
      type: 'coordinator.message.delta',
      messageId: 'assistant:1',
      channel: 'thinking',
      delta: '绝不能落盘的推理',
    }), null);
    const textEvent = {
      ...base, type: 'coordinator.message.delta' as const, messageId: 'assistant:1',
      channel: 'text' as const, delta: '公开正文',
    };
    assert.deepEqual(target.projector.project(textEvent)?.data, {
      piSessionId: 'pi-1', messageId: 'assistant:1', delta: '公开正文',
    });
    assert.equal(target.projector.project(textEvent), null);
    const event = {
      ...base,
      type: 'coordinator.tool.started' as const,
      toolCallId: 'tool-1',
      toolName: 'propose_task',
      argumentKeys: ['secret'],
    };
    const first = target.projector.project(event);
    const duplicate = target.projector.project(event);
    assert.ok(first);
    assert.equal(duplicate, null);
    assert.equal(target.eventRepository.latestCursor(), first.cursor);
    assert.equal(JSON.stringify(target.eventRepository.listAfter('0')).includes('secret'), false);
    assert.equal(JSON.stringify(target.eventRepository.listAfter('0')).includes('绝不能落盘'), false);
  } finally {
    await target.close();
  }
});

test('服务重启对 accepted/handoff 命令只做中断对账，不重放 Pi', async () => {
  const target = await harness();
  try {
    const binding = target.adapter.readActiveBranch('global-coordinator');
    assert.equal(binding.ok, true);
    target.commandRepository.createAccepted({
      commandId: 'restart-accepted',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'fingerprint-1',
      piSessionId: binding.ok ? binding.value.piSessionId : 'pi-missing',
    });
    target.commandRepository.createAccepted({
      commandId: 'restart-handed',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'fingerprint-2',
      piSessionId: binding.ok ? binding.value.piSessionId : 'pi-missing',
    });
    target.commandRepository.markHandedToPi('restart-handed', 'prompt');

    await target.commandService.reconcileOnStartup();
    assert.equal(target.commandService.get('restart-accepted').receipt?.error?.code, 'COMMAND_INTERRUPTED');
    assert.equal(target.commandService.get('restart-handed').receipt?.status, 'terminal');
    assert.equal(target.adapter.calls.some((call) => call.method === 'prompt'), false);
  } finally {
    await target.close();
  }
});

test('关闭并重开数据库后 accepted、handed 和 running 命令全部收敛为 interrupted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-reconcile-restart-'));
  const databasePath = join(root, 'data.sqlite');
  try {
    const firstStore = new SqliteAssistantStore(databasePath);
    const firstAdapter = new FakeCoordinatorAdapter();
    const firstSession = new AssistantSessionService({
      adapter: firstAdapter,
      bindingRepository: new SqliteAssistantBindingRepository(firstStore),
      pageStateRepository: new SqliteAssistantPageStateRepository(firstStore),
      runtimeConfig: config,
    });
    const binding = await firstSession.initialize();
    const firstCommands = new SqliteAssistantCommandRepository(firstStore);
    for (const [commandId, phase] of [
      ['restart-phase-accepted', 'accepted'],
      ['restart-phase-handed', 'handed'],
      ['restart-phase-running', 'running'],
    ] as const) {
      firstCommands.createAccepted({
        commandId,
        assistantSessionId: 'global-coordinator',
        kind: 'send',
        payloadFingerprint: `${commandId}-fingerprint`,
        piSessionId: binding.piSessionId,
      });
      if (phase !== 'accepted') firstCommands.markHandedToPi(commandId, 'prompt');
      if (phase === 'running') firstCommands.markRunning(commandId, 'old-run-ref');
    }
    firstAdapter.dispose();
    firstStore.close();

    const secondStore = new SqliteAssistantStore(databasePath);
    const secondAdapter = new FakeCoordinatorAdapter();
    const secondEvents = new AssistantEventStream();
    const secondCommands = new SqliteAssistantCommandRepository(secondStore);
    const secondService = new AssistantSessionService({
      adapter: secondAdapter,
      bindingRepository: new SqliteAssistantBindingRepository(secondStore),
      pageStateRepository: new SqliteAssistantPageStateRepository(secondStore),
      eventRepository: new SqliteAssistantEventRepository(secondStore),
      runtimeConfig: config,
    });
    const commandService = new AssistantTurnCommandService({
      sessionService: secondService,
      adapter: secondAdapter,
      commandRepository: secondCommands,
      eventStream: secondEvents,
    });
    await commandService.reconcileOnStartup();

    for (const commandId of [
      'restart-phase-accepted',
      'restart-phase-handed',
      'restart-phase-running',
    ]) {
      const receipt = commandService.get(commandId).receipt;
      assert.equal(receipt?.status, 'terminal');
      assert.equal(receipt?.terminalOutcome, 'failed');
      assert.equal(receipt?.error?.code, 'COMMAND_INTERRUPTED');
    }
    assert.equal(commandService.currentPromptCommandId(), null);
    assert.equal(secondAdapter.calls.some((call) => call.method === 'prompt'), false);
    secondAdapter.dispose();
    secondStore.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('命令查询逐步区分 unknown、accepted、handed、running 和 terminal', async () => {
  const target = await harness();
  try {
    assert.equal(target.commandService.get('status-1').status, 'unknown');
    target.commandRepository.createAccepted({
      commandId: 'status-1',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'fingerprint',
      piSessionId: 'pi-fake-global-coordinator',
    });
    assert.equal(target.commandService.get('status-1').status, 'accepted');
    target.commandRepository.markHandedToPi('status-1', 'prompt');
    assert.equal(target.commandService.get('status-1').status, 'handed_to_pi');
    target.commandRepository.markRunning('status-1', 'pi-turn-ref');
    assert.equal(target.commandService.get('status-1').status, 'running');
    target.commandRepository.reconcile('status-1', 'succeeded');
    assert.equal(target.commandService.get('status-1').status, 'terminal');
  } finally {
    await target.close();
  }
});

test('启动对账不把当前 adapter streaming 误认为旧 provider stream 可恢复', async () => {
  const target = await harness(80);
  try {
    target.commandRepository.createAccepted({
      commandId: 'restart-running',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'fingerprint-running',
      piSessionId: 'pi-fake-global-coordinator',
    });
    target.commandRepository.markHandedToPi('restart-running', 'prompt');
    const prompt = target.adapter.prompt('global-coordinator', '恢复中的 prompt');
    await new Promise((resolve) => setTimeout(resolve, 10));

    await target.commandService.reconcileOnStartup();
    assert.equal(target.commandService.get('restart-running').status, 'terminal');
    assert.equal(
      target.commandService.get('restart-running').receipt?.error?.code,
      'COMMAND_INTERRUPTED',
    );
    assert.equal(target.commandService.currentPromptCommandId(), null);
    await prompt;
  } finally {
    await target.close();
  }
});

test('prompt pre-streaming 窗口拒绝第二个命令，进入 streaming 后才接受显式行为', async () => {
  const promptGate = deferred<void>();
  const promptCompletion = deferred<void>();
  const target = await harness(0, promptGate.promise, {
    promptCompletionBarrier: promptCompletion.promise,
  });
  try {
    const first = target.commandService.send(send('pre-stream-prompt', '第一个 prompt'));
    while (!target.adapter.calls.some((call) => call.method === 'prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(target.adapter.isStreaming('global-coordinator'), { ok: true, value: false });

    const missingBehavior = await target.commandService.send(
      send('pre-stream-missing', '不能成为第二个 prompt'),
    );
    assert.equal(missingBehavior.terminalOutcome, 'rejected');
    assert.equal(missingBehavior.error?.code, 'COMMAND_STATE_MISMATCH');

    for (const behavior of ['steer', 'followUp'] as const) {
      const receipt = await target.commandService.send(
        send(`pre-stream-${behavior}`, `显式 ${behavior}`, behavior),
      );
      assert.equal(receipt.terminalOutcome, 'rejected');
      assert.equal(receipt.error?.code, 'COMMAND_STATE_MISMATCH');
      assert.match(receipt.error?.message ?? '', /尚未进入可追加状态/u);
    }
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
    assert.equal(target.adapter.calls.filter((call) => call.method === 'steer').length, 0);
    assert.equal(target.adapter.calls.filter((call) => call.method === 'followUp').length, 0);
    assert.equal(target.commandService.currentPromptCommandId(), 'pre-stream-prompt');

    const processing = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.processing',
    );
    promptGate.resolve();
    await processing;
    assert.deepEqual(target.adapter.isStreaming('global-coordinator'), { ok: true, value: true });

    const steer = await target.commandService.send(
      send('streaming-steer', '进入 streaming 后 steer', 'steer'),
    );
    const followUp = await target.commandService.send(
      send('streaming-follow-up', '进入 streaming 后 followUp', 'followUp'),
    );
    assert.equal(steer.terminalOutcome, 'accepted');
    assert.equal(followUp.terminalOutcome, 'accepted');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'steer').length, 1);
    assert.equal(target.adapter.calls.filter((call) => call.method === 'followUp').length, 1);

    promptCompletion.resolve();
    assert.equal((await first).terminalOutcome, 'succeeded');
    assert.equal(target.commandService.currentPromptCommandId(), null);

    const afterCompletion = await target.commandService.send(
      send('post-stream-prompt', '完成后可启动下一次'),
    );
    assert.equal(afterCompletion.terminalOutcome, 'succeeded');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 2);
  } finally {
    promptGate.resolve();
    promptCompletion.resolve();
    await target.close();
  }
});

test('Pi 公共事件与 command receipt 在同一 SQLite 事务，更新失败时共同回滚且不广播', async () => {
  const target = await harness();
  try {
    target.commandRepository.createAccepted({
      commandId: 'atomic-projection',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'atomic-fingerprint',
      piSessionId: 'pi-fake-global-coordinator',
    });
    target.commandRepository.markHandedToPi('atomic-projection', 'prompt');
    const projected: AssistantPublicEvent[] = [];
    const unsubscribe = target.eventStream.subscribe((event) => projected.push(event));
    const inspection = new DatabaseSync(join(target.root, 'data.sqlite'));
    inspection.exec(`
      CREATE TRIGGER fail_atomic_projection_receipt
      BEFORE UPDATE ON assistant_command_receipt
      WHEN NEW.command_id = 'atomic-projection'
      BEGIN
        SELECT RAISE(FAIL, 'injected receipt failure');
      END;
    `);
    const projector = new AssistantEventProjector({
      adapter: target.adapter,
      eventRepository: target.eventRepository,
      eventStream: target.eventStream,
      assistantSessionId: 'global-coordinator',
      currentPromptCommandId: () => 'atomic-projection',
    });
    const event = {
      eventId: 'pi-atomic:boot-1:1',
      cursor: 'pi-atomic:boot-1:1',
      sequence: 1,
      sourceInstanceId: 'boot-1',
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-atomic',
      occurredAt: '2026-09-14T08:00:00.000Z',
      type: 'coordinator.run.started' as const,
    };

    assert.throws(() => projector.project(event), /injected receipt failure/u);
    assert.equal(target.commandRepository.get('atomic-projection')?.status, 'handed_to_pi');
    assert.equal(
      inspection.prepare(`
        SELECT COUNT(*) AS count FROM assistant_event_projection
        WHERE source_key LIKE 'pi:pi-atomic:%'
      `).get().count,
      0,
    );
    assert.deepEqual(projected, []);

    inspection.exec('DROP TRIGGER fail_atomic_projection_receipt;');
    const stored = projector.project(event);
    assert.ok(stored);
    assert.equal(target.commandRepository.get('atomic-projection')?.status, 'running');
    assert.deepEqual(projected.map((item) => item.eventId), [stored.eventId]);
    unsubscribe();
    inspection.close();
  } finally {
    await target.close();
  }
});

test('Pi terminal 投影与 command receipt 原子提交，回执更新失败时共同回滚', async () => {
  const target = await harness();
  try {
    target.commandRepository.createAccepted({
      commandId: 'atomic-terminal',
      assistantSessionId: 'global-coordinator',
      kind: 'send',
      payloadFingerprint: 'atomic-terminal-fingerprint',
      piSessionId: 'pi-fake-global-coordinator',
    });
    target.commandRepository.markHandedToPi('atomic-terminal', 'prompt');
    const projected: AssistantPublicEvent[] = [];
    const unsubscribe = target.eventStream.subscribe((event) => projected.push(event));
    const inspection = new DatabaseSync(join(target.root, 'data.sqlite'));
    inspection.exec(`
      CREATE TRIGGER fail_atomic_terminal_receipt
      BEFORE UPDATE ON assistant_command_receipt
      WHEN NEW.command_id = 'atomic-terminal'
      BEGIN
        SELECT RAISE(FAIL, 'injected terminal receipt failure');
      END;
    `);
    const projector = new AssistantEventProjector({
      adapter: target.adapter,
      eventRepository: target.eventRepository,
      eventStream: target.eventStream,
      assistantSessionId: 'global-coordinator',
      currentPromptCommandId: () => 'atomic-terminal',
    });
    const event = {
      eventId: 'pi-terminal:boot-1:2',
      cursor: 'pi-terminal:boot-1:2',
      sequence: 2,
      sourceInstanceId: 'boot-1',
      assistantSessionId: 'global-coordinator',
      piSessionId: 'pi-terminal',
      occurredAt: '2026-09-14T08:00:01.000Z',
      type: 'coordinator.run.completed' as const,
    };

    assert.throws(() => projector.project(event), /injected terminal receipt failure/u);
    assert.equal(target.commandRepository.get('atomic-terminal')?.status, 'handed_to_pi');
    assert.equal(
      inspection.prepare(`
        SELECT COUNT(*) AS count FROM assistant_event_projection
        WHERE source_key LIKE 'pi:pi-terminal:%'
      `).get().count,
      0,
    );
    assert.deepEqual(projected, []);

    inspection.exec('DROP TRIGGER fail_atomic_terminal_receipt;');
    const stored = projector.project(event);
    assert.ok(stored);
    const receipt = target.commandRepository.get('atomic-terminal');
    assert.equal(receipt?.status, 'terminal');
    assert.equal(receipt?.terminalOutcome, 'succeeded');
    assert.deepEqual(projected.map((item) => item.eventId), [stored.eventId]);
    unsubscribe();
    inspection.close();
  } finally {
    await target.close();
  }
});

test('关闭并重建 store、adapter 和 service 后，同 sequence 的新 source instance 仍完整投影', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-turn-restart-source-'));
  const databasePath = join(root, 'data.sqlite');

  const createRuntime = async (sourceInstanceId: string) => {
    const store = new SqliteAssistantStore(databasePath);
    const adapter = new FakeCoordinatorAdapter({ sourceInstanceIdFactory: () => sourceInstanceId });
    const commandRepository = new SqliteAssistantCommandRepository(store);
    const eventRepository = new SqliteAssistantEventRepository(store);
    const eventStream = new AssistantEventStream();
    const sessionService = new AssistantSessionService({
      adapter,
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      eventRepository,
      runtimeConfig: config,
    });
    await sessionService.initialize();
    const commandService = new AssistantTurnCommandService({
      sessionService,
      adapter,
      commandRepository,
      eventStream,
    });
    const projector = new AssistantEventProjector({
      adapter,
      eventRepository,
      eventStream,
      assistantSessionId: 'global-coordinator',
      currentPromptCommandId: () => commandService.currentPromptCommandId(),
    });
    projector.start();
    return { store, adapter, commandService, eventRepository, projector };
  };

  try {
    const first = await createRuntime('boot-1');
    assert.equal((await first.commandService.send(send('restart-source-1', '第一次运行'))).terminalOutcome, 'succeeded');
    first.projector.close();
    first.adapter.dispose();
    first.store.close();

    const second = await createRuntime('boot-2');
    assert.equal((await second.commandService.send(send('restart-source-2', '第二次运行'))).terminalOutcome, 'succeeded');
    const events = second.eventRepository.listAfter('0');
    assert.equal(events.filter((event) => event.type === 'assistant.run.processing').length, 2);
    assert.equal(events.filter((event) => event.type === 'assistant.run.succeeded').length, 2);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    const sourceKeys = inspection.prepare(`
      SELECT source_key FROM assistant_event_projection
      WHERE source_key LIKE 'pi:%' ORDER BY cursor
    `).all() as Array<{ source_key: string }>;
    inspection.close();
    assert.equal(sourceKeys.some((row) => row.source_key.includes(':boot-1:')), true);
    assert.equal(sourceKeys.some((row) => row.source_key.includes(':boot-2:')), true);
    assert.equal(new Set(sourceKeys.map((row) => row.source_key)).size, sourceKeys.length);
    second.projector.close();
    second.adapter.dispose();
    second.store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
