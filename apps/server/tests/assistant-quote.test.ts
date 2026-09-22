import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AssistantMessageView,
  AssistantPublicEvent,
  AssistantQuote,
  CoordinatorRuntimeConfig,
  SendAssistantMessageCommand,
} from '@multivac/contracts';
import { ASSISTANT_QUOTE_MAX_UTF8_BYTES } from '@multivac/contracts';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { AssistantEventProjector } from '../src/application/assistant-event-projector.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import {
  AssistantTurnCommandService,
  AssistantTurnCommandServiceError,
} from '../src/application/assistant-turn-command-service.js';
import { validateAssistantQuote } from '../src/modules/sessions/assistant-quote.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';
import {
  ASSISTANT_QUOTE_CUSTOM_TYPE,
  assistantQuoteDetails,
  readAssistantQuoteDetails,
  renderAssistantQuoteForModel,
} from '../src/runtime/executors/pi-quote-carriage.js';
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

const AT = '2026-09-22T08:00:00.000Z';

const history: AssistantMessageView[] = [
  {
    id: 'fixture:entry-1', piSessionId: 'fixture', piEntryId: 'entry-1', role: 'user',
    text: '先看看现状。', createdAt: AT,
  },
  {
    id: 'fixture:entry-2', piSessionId: 'fixture', piEntryId: 'entry-2', role: 'assistant',
    text: '会话恢复分两步：\n\n1. 读取 binding\n2. 校准 Pi 历史', createdAt: AT,
  },
];

function messageEntry(
  id: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  text: string,
): SessionEntry {
  return {
    type: 'message', id, parentId, timestamp: AT,
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }], timestamp: 0 },
  } as unknown as SessionEntry;
}

function quoteEntry(id: string, parentId: string | null, details: unknown): SessionEntry {
  return {
    type: 'custom_message', id, parentId, timestamp: AT,
    customType: ASSISTANT_QUOTE_CUSTOM_TYPE, content: '引用正文', display: false, details,
  } as unknown as SessionEntry;
}

function waitForEvent(
  stream: AssistantEventStream,
  predicate: (event: AssistantPublicEvent) => boolean,
): Promise<AssistantPublicEvent> {
  return new Promise((resolve) => {
    const unsubscribe = stream.subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

async function harness(promptCompletionBarrier?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-quote-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({
    history,
    ...(promptCompletionBarrier ? { promptCompletionBarrier } : {}),
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
  const binding = await sessionService.initialize();
  const commandService = new AssistantTurnCommandService({
    sessionService, adapter, commandRepository, eventStream,
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
    adapter,
    commandRepository,
    commandService,
    eventStream,
    piSessionId: binding.piSessionId,
    async close() {
      projector.close();
      adapter.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function send(
  commandId: string,
  text: string,
  quote?: AssistantQuote,
  streamingBehavior?: 'steer' | 'followUp',
): SendAssistantMessageCommand {
  return {
    commandId,
    assistantSessionId: 'global-coordinator',
    text,
    contextRefs: [],
    ...(quote ? { quote } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  };
}

test('Pi 历史按 entry 父子关系还原引用，不解析正文且兼容无引用的旧记录', () => {
  const details = assistantQuoteDetails({
    sourcePiEntryId: 'entry-2', sourceRole: 'assistant', text: '1. 读取 binding\n2. 校准 Pi 历史',
  });
  const messages = mapPiActiveBranch('pi-1', [
    messageEntry('entry-1', null, 'user', '先看看现状。'),
    messageEntry('entry-2', 'entry-1', 'assistant', '会话恢复分两步。'),
    quoteEntry('quote-1', 'entry-2', details),
    messageEntry('entry-3', 'quote-1', 'user', '这一步具体做什么？'),
    // 未知 customType 与无法识别的 details 都不产生引用，但消息本身照常展示。
    quoteEntry('quote-2', 'entry-3', { version: 99, text: '旧版本' }),
    messageEntry('entry-4', 'quote-2', 'user', '没有引用的追问。'),
    messageEntry('entry-5', 'entry-4', 'assistant', '好的。'),
  ]);

  assert.deepEqual(messages.map((message) => message.piEntryId), [
    'entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-5',
  ]);
  assert.deepEqual(messages[2]?.quote, {
    sourcePiSessionId: 'pi-1',
    sourcePiEntryId: 'entry-2',
    sourceRole: 'assistant',
    // 换行与缩进原样保留，不做空白归一。
    text: '1. 读取 binding\n2. 校准 Pi 历史',
  });
  assert.equal(messages[0]?.quote, undefined);
  assert.equal(messages[3]?.quote, undefined);
  assert.equal(messages[4]?.quote, undefined);
});

test('引用 details 编解码只接受当前版本的完整字段，交给模型的正文不提升为指令', () => {
  const quote = { sourcePiEntryId: 'entry-2', sourceRole: 'assistant' as const, text: '引用正文' };
  assert.deepEqual(readAssistantQuoteDetails(assistantQuoteDetails(quote)), {
    version: 1, sourceEntryId: 'entry-2', sourceRole: 'assistant', text: '引用正文',
  });
  for (const broken of [
    null, '字符串', { version: 2, sourceEntryId: 'e', sourceRole: 'assistant', text: 't' },
    { version: 1, sourceEntryId: '', sourceRole: 'assistant', text: 't' },
    { version: 1, sourceEntryId: 'e', sourceRole: 'system', text: 't' },
    { version: 1, sourceEntryId: 'e', sourceRole: 'assistant', text: '' },
  ]) {
    assert.equal(readAssistantQuoteDetails(broken), null);
  }

  const rendered = renderAssistantQuoteForModel(quote);
  assert.equal(rendered.includes('引用正文'), true);
  assert.equal(/system|developer|指令|忽略/u.test(rendered.replace('引用正文', '')), false);
});

test('引用校验只认当前会话内真实存在且角色一致的来源', () => {
  const context = { piSessionId: 'fixture', messages: history };
  const valid: AssistantQuote = {
    sourcePiSessionId: 'fixture', sourcePiEntryId: 'entry-2', sourceRole: 'assistant',
    text: '1. 读取 binding',
  };
  assert.equal(validateAssistantQuote(valid, context), null);

  for (const [label, quote] of [
    ['跨会话伪造', { ...valid, sourcePiSessionId: 'other-session' }],
    ['来源不存在', { ...valid, sourcePiEntryId: 'entry-999' }],
    ['角色不一致', { ...valid, sourceRole: 'user' as const }],
    ['空引用', { ...valid, text: '   ' }],
    ['超出字节上限', { ...valid, text: '中'.repeat(ASSISTANT_QUOTE_MAX_UTF8_BYTES / 3 + 1) }],
  ] as const) {
    const rejection = validateAssistantQuote(quote, context);
    assert.equal(rejection?.code, 'INVALID_REQUEST', label);
  }
});

test('发送携带引用时引用与正文一起交给 Pi，并随用户消息回到历史', async () => {
  const target = await harness();
  try {
    const quote: AssistantQuote = {
      sourcePiSessionId: target.piSessionId, sourcePiEntryId: 'entry-2',
      sourceRole: 'assistant', text: '1. 读取 binding\n2. 校准 Pi 历史',
    };
    const receipt = await target.commandService.send(send('quote-send', '第二步怎么校准？', quote));
    assert.equal(receipt.terminalOutcome, 'succeeded');

    const prompt = target.adapter.calls.find((call) => call.method === 'prompt');
    assert.ok(prompt && 'quote' in prompt);
    assert.deepEqual(prompt.quote, {
      sourcePiEntryId: 'entry-2', sourceRole: 'assistant', text: quote.text,
    });

    const snapshot = target.adapter.readActiveBranch('global-coordinator');
    assert.ok(snapshot.ok);
    const submitted = snapshot.value.messages.find((message) => message.text === '第二步怎么校准？');
    assert.deepEqual(submitted?.quote, quote);
  } finally {
    await target.close();
  }
});

test('同 commandId 携带不同引用视为冲突，不复用原回执', async () => {
  const target = await harness();
  try {
    const quote: AssistantQuote = {
      sourcePiSessionId: target.piSessionId, sourcePiEntryId: 'entry-2',
      sourceRole: 'assistant', text: '1. 读取 binding',
    };
    await target.commandService.send(send('quote-fingerprint', '这一步做什么？', quote));
    // 同正文同 commandId，只换引用文本。
    await assert.rejects(
      target.commandService.send(send('quote-fingerprint', '这一步做什么？', {
        ...quote, text: '2. 校准 Pi 历史',
      })),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
    // 去掉引用同样是另一次发送。
    await assert.rejects(
      target.commandService.send(send('quote-fingerprint', '这一步做什么？')),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'COMMAND_ID_CONFLICT',
    );
  } finally {
    await target.close();
  }
});

test('伪造来源的引用在建立回执前被拒绝，命令账本不留痕迹', async () => {
  const target = await harness();
  try {
    await assert.rejects(
      target.commandService.send(send('quote-forged', '这一步做什么？', {
        sourcePiSessionId: 'other-session', sourcePiEntryId: 'entry-2',
        sourceRole: 'assistant', text: '别的会话的内容',
      })),
      (error: unknown) => error instanceof AssistantTurnCommandServiceError &&
        error.code === 'INVALID_REQUEST',
    );
    assert.equal(target.commandRepository.get('quote-forged'), undefined);
    assert.equal(target.adapter.calls.some((call) => call.method === 'prompt'), false);
  } finally {
    await target.close();
  }
});

test('运行中的补充指令同样携带引用，且不会启动第二个并发执行', async () => {
  let releaseCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });
  const target = await harness(completion);
  try {
    const quote: AssistantQuote = {
      sourcePiSessionId: target.piSessionId, sourcePiEntryId: 'entry-2',
      sourceRole: 'assistant', text: '2. 校准 Pi 历史',
    };
    const processing = waitForEvent(
      target.eventStream,
      (event) => event.type === 'assistant.run.processing',
    );
    const running = target.commandService.send(send('quote-running-prompt', '先启动一次运行'));
    await processing;

    const steered = await target.commandService.send(
      send('quote-steer', '改成先核对这一步', quote, 'steer'),
    );
    const followedUp = await target.commandService.send(
      send('quote-follow-up', '结束后再展开这一步', quote, 'followUp'),
    );
    assert.equal(steered.terminalOutcome, 'accepted');
    assert.equal(followedUp.terminalOutcome, 'accepted');

    const expected = {
      sourcePiEntryId: 'entry-2', sourceRole: 'assistant', text: '2. 校准 Pi 历史',
    };
    const steer = target.adapter.calls.find((call) => call.method === 'steer');
    const followUp = target.adapter.calls.find((call) => call.method === 'followUp');
    assert.ok(steer && 'quote' in steer);
    assert.ok(followUp && 'quote' in followUp);
    assert.deepEqual(steer.quote, expected);
    assert.deepEqual(followUp.quote, expected);
    // 补充指令只入队到原运行，不得新开一次 prompt。
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);

    releaseCompletion();
    assert.equal((await running).terminalOutcome, 'succeeded');
  } finally {
    releaseCompletion();
    await target.close();
  }
});
