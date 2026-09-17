import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  request,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  type AssistantPublicEvent,
  type CoordinatorRuntimeConfig,
} from '@multivac/contracts';
import { AssistantEventProjector } from '../src/application/assistant-event-projector.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import {
  createAssistantRequestHandler,
  createAssistantSseConnection,
} from '../src/adapters/http/assistant-routes.js';
import { createMultivacHttpServer } from '../src/bootstrap/server.js';
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

async function harness(options: {
  promptDelayMs?: number;
  promptBarrier?: Promise<void>;
  promptCompletionBarrier?: Promise<void>;
  promptReturnBarrier?: Promise<void>;
  abortBarrier?: Promise<void>;
  maxQueuedBytes?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-assistant-turn-http-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const adapter = new FakeCoordinatorAdapter({
    promptDelayMs: options.promptDelayMs ?? 0,
    promptBarrier: options.promptBarrier,
    promptCompletionBarrier: options.promptCompletionBarrier,
    promptReturnBarrier: options.promptReturnBarrier,
    abortBarrier: options.abortBarrier,
  });
  const commandRepository = new SqliteAssistantCommandRepository(store);
  const eventRepository = new SqliteAssistantEventRepository(store);
  const eventStream = new AssistantEventStream();
  const service = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    eventRepository,
    runtimeConfig: config,
  });
  await service.initialize();
  const commandService = new AssistantTurnCommandService({
    sessionService: service,
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
  const server = createMultivacHttpServer({
    service,
    commandService,
    eventRepository,
    eventStream,
    heartbeatMs: 25,
    maxQueuedBytes: options.maxQueuedBytes,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    port: address.port,
    root,
    store,
    adapter,
    commandRepository,
    eventRepository,
    eventStream,
    service,
    commandService,
    projector,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      projector.close();
      adapter.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

class ControlledRequest extends EventEmitter {
  method = 'GET';
  url = '/api/assistant/events?after=0';
  headers: Record<string, string> = { accept: 'text/event-stream' };
}

class ControlledResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  readonly writes: string[] = [];

  constructor(private readonly writeResults: boolean[] = []) {
    super();
  }

  writeHead(): this {
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string | Buffer): boolean {
    this.writes.push(String(chunk));
    return this.writeResults.shift() ?? true;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('HTTP 恢复快照与 cursor 一致，正文续传按多消息身份衔接且历史校准不重新回答', async () => {
  const target = await harness();
  try {
    const initial = await target.service.getSessionPage({});
    let sequence = 900;
    const project = (messageId: string, text: string) => {
      sequence += 1;
      return target.projector.project({
        type: 'coordinator.message.delta', channel: 'text', delta: text, messageId,
        assistantSessionId: initial.assistantSessionId, piSessionId: initial.piSessionId,
        sourceInstanceId: 'stream-test', sequence, eventId: `stream:${sequence}`,
        cursor: `stream:${sequence}`, occurredAt: '2026-09-17T00:00:00Z',
      });
    };
    project('assistant:9', '第一条');
    project('assistant:9:2', '第二');
    const response = await jsonRequest(target.port, '/api/assistant/session?limit=1');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.streamingMessages.map((message: { text: string }) => message.text), ['第一条', '第二']);
    assert.equal(response.body.eventCursor, target.eventRepository.latestCursor());
    project('assistant:9:2', '条');
    const replay = target.eventRepository.listAfter(response.body.eventCursor);
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0]?.data, {
      piSessionId: initial.piSessionId, messageId: 'assistant:9:2', delta: '条',
    });
    target.adapter.appendAssistantHistoryForTest(initial.assistantSessionId, '第一条校准', 'entry-completed', 'assistant:9');
    const latest = await target.service.getSessionPage({ limit: 1 });
    assert.deepEqual(latest.messages.map((message) => message.text), ['第一条校准']);
    assert.deepEqual(latest.streamingMessages?.map((message) => message.text), ['第二条']);
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 0);
  } finally {
    await target.close();
  }
});

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

function jsonRequest(
  port: number,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function sendBody(commandId: string, text: string) {
  return {
    commandId,
    assistantSessionId: 'global-coordinator',
    text,
    contextRefs: [],
  };
}

function openSse(port: number, after = '0') {
  let req!: ClientRequest;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req = request({
      hostname: '127.0.0.1', port, path: `/api/assistant/events?after=${after}`,
      headers: { accept: 'text/event-stream' },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  return { req, response };
}

function collectEvents(response: IncomingMessage, count: number): Promise<AssistantPublicEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AssistantPublicEvent[] = [];
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        events.push(JSON.parse(data.slice(6)) as AssistantPublicEvent);
        if (events.length >= count) resolve(events);
      }
    });
    response.on('error', reject);
  });
}

test('turn HTTP 校验 12 KiB/80 KiB/contextRefs、幂等冲突和命令对账', async () => {
  const target = await harness();
  try {
    const sent = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-command-1', '发送正文'),
    });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.terminalOutcome, 'succeeded');

    const replay = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-command-1', '发送正文'),
    });
    assert.equal(replay.status, 200);
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);

    const conflict = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-command-1', '不同正文'),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'COMMAND_ID_CONFLICT');
    const reconciled = await jsonRequest(target.port, '/api/assistant/commands/http-command-1');
    assert.equal(reconciled.body.status, 'terminal');

    const contextRefs = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: { ...sendBody('context-1', '正文'), contextRefs: ['browser'] },
    });
    assert.equal(contextRefs.status, 400);
    const oversizedChinese = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST',
      body: sendBody('large-1', '中'.repeat(Math.floor(ASSISTANT_DRAFT_MAX_UTF8_BYTES / 3) + 1)),
    });
    assert.equal(oversizedChinese.status, 413);
    const oversizedAscii = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST',
      body: sendBody('large-ascii', 'x'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES + 1)),
    });
    assert.equal(oversizedAscii.status, 413);
    const oversizedBody = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST',
      body: sendBody('large-body', 'x'.repeat(90 * 1024)),
    });
    assert.equal(oversizedBody.status, 413);
    const escaped = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST',
      body: sendBody('escaped-1', '\\'.repeat(ASSISTANT_DRAFT_MAX_UTF8_BYTES)),
    });
    assert.equal(escaped.status, 200);
  } finally {
    await target.close();
  }
});

test('POST 客户端断开不触发 abort，稍后可按 commandId 看到真实终态', async () => {
  const target = await harness({ promptDelayMs: 80 });
  try {
    const body = JSON.stringify(sendBody('disconnect-1', '客户端会提前断开'));
    const req = request({
      hostname: '127.0.0.1', port: target.port, path: '/api/assistant/turns', method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.end(body);
    setTimeout(() => req.destroy(), 10);

    await new Promise((resolve) => setTimeout(resolve, 130));
    const result = await jsonRequest(target.port, '/api/assistant/commands/disconnect-1');
    assert.equal(result.body.status, 'terminal');
    assert.equal(result.body.receipt.terminalOutcome, 'succeeded');
    assert.equal(target.adapter.calls.some((call) => call.method === 'abort'), false);
  } finally {
    await target.close();
  }
});

test('并发 HTTP 相同 commandId 不同 payload 在首个 prompt barrier 前返回 409', async () => {
  let releasePrompt!: () => void;
  const promptBarrier = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const target = await harness({ promptBarrier });
  try {
    const first = jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-concurrent-conflict', '首个正文'),
    });
    while (!target.adapter.calls.some((call) => call.method === 'prompt')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const conflict = await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-concurrent-conflict', '错误正文'),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'COMMAND_ID_CONFLICT');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'prompt').length, 1);
    assert.equal(
      target.adapter.calls.find((call) => call.method === 'prompt' && 'text' in call)?.text,
      '首个正文',
    );

    releasePrompt();
    const receipt = await first;
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.terminalOutcome, 'succeeded');
    assert.notDeepEqual(conflict.body, receipt.body);
  } finally {
    releasePrompt();
    await target.close();
  }
});

test('prompt 已 terminal 时 HTTP cancel 返回 no-active-turn 且保持 succeeded', async () => {
  const promptReturn = deferred();
  const target = await harness({ promptReturnBarrier: promptReturn.promise });
  try {
    const succeeded = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.succeeded',
    );
    const prompt = jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-terminal-before-cancel', '完成后再取消'),
    });
    await succeeded;

    const cancel = await jsonRequest(target.port, '/api/assistant/turns/current/cancel', {
      method: 'POST',
      body: {
        commandId: 'http-terminal-before-cancel-command',
        assistantSessionId: 'global-coordinator',
      },
    });
    assert.equal(cancel.status, 422);
    assert.equal(cancel.body.error.code, 'COMMAND_STATE_MISMATCH');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 0);

    const reconciliation = await jsonRequest(
      target.port,
      '/api/assistant/commands/http-terminal-before-cancel',
    );
    assert.equal(reconciliation.body.status, 'terminal');
    assert.equal(reconciliation.body.receipt.terminalOutcome, 'succeeded');

    promptReturn.resolve();
    const promptResponse = await prompt;
    assert.equal(promptResponse.status, 200);
    assert.equal(promptResponse.body.terminalOutcome, 'succeeded');
  } finally {
    promptReturn.resolve();
    await target.close();
  }
});

test('不同 cancel commandId 并发命中同一 prompt 时 HTTP 回执独立且 Pi abort 只调用一次', async () => {
  const promptCompletion = deferred();
  const abortBarrier = deferred();
  const target = await harness({
    promptCompletionBarrier: promptCompletion.promise,
    abortBarrier: abortBarrier.promise,
  });
  try {
    const processing = waitForEvents(
      target.eventStream,
      1,
      (event) => event.type === 'assistant.run.processing',
    );
    const prompt = jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('http-concurrent-cancel-prompt', '等待两个取消命令'),
    });
    await processing;

    const handedCancels = waitForEvents(
      target.eventStream,
      2,
      (event) => event.type === 'assistant.command.handed_to_pi' && event.data.dispatchMode === 'abort',
    );
    const cancelA = jsonRequest(target.port, '/api/assistant/turns/current/cancel', {
      method: 'POST',
      body: { commandId: 'http-concurrent-cancel-a', assistantSessionId: 'global-coordinator' },
    });
    const cancelB = jsonRequest(target.port, '/api/assistant/turns/current/cancel', {
      method: 'POST',
      body: { commandId: 'http-concurrent-cancel-b', assistantSessionId: 'global-coordinator' },
    });
    await handedCancels;
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);

    abortBarrier.resolve();
    const [responseA, responseB] = await Promise.all([cancelA, cancelB]);
    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    assert.equal(responseA.body.terminalOutcome, 'accepted');
    assert.equal(responseB.body.terminalOutcome, 'accepted');
    assert.notEqual(responseA.body.commandId, responseB.body.commandId);

    promptCompletion.resolve();
    const promptResponse = await prompt;
    assert.equal(promptResponse.body.terminalOutcome, 'cancelled');
    assert.equal(target.adapter.calls.filter((call) => call.method === 'abort').length, 1);
  } finally {
    abortBarrier.resolve();
    promptCompletion.resolve();
    await target.close();
  }
});

test('SSE 先 replay 后 live，按 cursor 重连不重复并在断开后清理订阅', async () => {
  const target = await harness({ promptDelayMs: 20 });
  try {
    const firstConnection = openSse(target.port);
    const firstResponse = await firstConnection.response;
    const eventsPromise = collectEvents(firstResponse, 5);
    await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('sse-command-1', '触发 SSE'),
    });
    const events = await eventsPromise;
    assert.deepEqual(events.map((event) => Number(event.cursor)),
      [...events].map((event) => Number(event.cursor)).sort((a, b) => a - b));
    assert.equal(new Set(events.map((event) => event.cursor)).size, events.length);
    firstResponse.destroy();
    firstConnection.req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = events[1]!.cursor;
    const replayConnection = openSse(target.port, after);
    const replayResponse = await replayConnection.response;
    const replayed = await collectEvents(replayResponse, events.length - 2);
    assert.equal(replayed.every((event) => Number(event.cursor) > Number(after)), true);
    assert.equal(replayed.some((event) => event.cursor === after), false);
    replayResponse.destroy();
    replayConnection.req.destroy();

    const headerReplay = new Promise<IncomingMessage>((resolve, reject) => {
      const requestWithHeader = request({
        hostname: '127.0.0.1',
        port: target.port,
        path: '/api/assistant/events',
        headers: { accept: 'text/event-stream', 'last-event-id': after },
      }, resolve);
      requestWithHeader.on('error', reject);
      requestWithHeader.end();
    });
    const headerResponse = await headerReplay;
    const headerEvents = await collectEvents(headerResponse, 1);
    assert.equal(Number(headerEvents[0]!.cursor) > Number(after), true);
    headerResponse.destroy();

    const conflict = await jsonRequest(target.port, `/api/assistant/events?after=${after}`, {
      headers: { 'last-event-id': '0' },
    });
    assert.equal(conflict.status, 400);
    const expired = await jsonRequest(target.port, '/api/assistant/events?after=999999');
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, 'EVENT_CURSOR_EXPIRED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});

test('SSE 事件裁剪后的旧 cursor 返回稳定可识别的 expired 响应', async () => {
  const target = await harness();
  try {
    await jsonRequest(target.port, '/api/assistant/turns', {
      method: 'POST', body: sendBody('trimmed-cursor-command', '生成可裁剪事件'),
    });
    const inspection = new DatabaseSync(join(target.root, 'data.sqlite'));
    inspection.prepare('DELETE FROM assistant_event_projection WHERE cursor <= 2').run();
    inspection.close();

    const expired = await jsonRequest(target.port, '/api/assistant/events?after=0');
    assert.equal(expired.status, 409);
    assert.deepEqual(expired.body, {
      error: {
        code: 'EVENT_CURSOR_EXPIRED',
        message: '公共事件游标已失效，需要重新读取会话快照。',
      },
    });
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});

test('SSE 慢客户端超过字节上限会主动关闭并释放 listener', async () => {
  const target = await harness({ maxQueuedBytes: 100 });
  try {
    const connection = openSse(target.port);
    const response = await connection.response;
    const event = target.eventRepository.append({
      sourceKey: 'slow-client-event',
      assistantSessionId: 'global-coordinator',
      commandId: null,
      type: 'assistant.tool.started',
      data: { toolCallId: 'tool-1', toolName: 'x'.repeat(500) },
      occurredAt: '2026-09-14T08:00:00.000Z',
    });
    target.eventStream.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(response.destroyed, true);
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});

test('SSE heartbeat 在 write(false) 后停止写入，drain 恢复且 close 清理全部引用', async () => {
  const target = await harness();
  try {
    const request = new ControlledRequest();
    const response = new ControlledResponse([false]);
    let closeCount = 0;
    const connection = createAssistantSseConnection({
      request: request as unknown as IncomingMessage,
      response: response as unknown as ServerResponse,
      initialCursor: '0',
      eventRepository: target.eventRepository,
      eventStream: target.eventStream,
      heartbeatMs: 5,
      maxQueuedEvents: 4,
      maxQueuedBytes: 1024,
      onClose: () => { closeCount += 1; },
    });
    connection.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(response.writes, [': connected\n\n']);

    response.emit('drain');
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(response.writes.some((chunk) => chunk.startsWith(': heartbeat')), true);

    connection.close();
    const writesAfterClose = response.writes.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(response.writes.length, writesAfterClose);
    assert.equal(closeCount, 1);
    assert.equal(target.eventStream.listenerCount(), 0);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(response.listenerCount('drain'), 0);
    assert.equal(response.listenerCount('close'), 0);
    assert.equal(response.listenerCount('error'), 0);
  } finally {
    await target.close();
  }
});

test('SSE replay 内同步关闭不会注册陈旧连接，重复连接计数与监听器保持为零', async () => {
  const target = await harness();
  try {
    target.eventRepository.append({
      sourceKey: 'replay-close-event',
      assistantSessionId: 'global-coordinator',
      commandId: null,
      type: 'assistant.tool.started',
      data: { toolCallId: 'tool-replay-close', toolName: 'x'.repeat(500) },
      occurredAt: '2026-09-14T08:00:00.000Z',
    });
    const handler = createAssistantRequestHandler({
      service: target.service,
      commandService: target.commandService,
      eventRepository: target.eventRepository,
      eventStream: target.eventStream,
      heartbeatMs: 5,
      maxQueuedBytes: 64,
    });

    for (let index = 0; index < 3; index += 1) {
      const request = new ControlledRequest();
      const response = new ControlledResponse([false]);
      await handler.handle(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
      );
      assert.equal(response.destroyed, true);
      assert.equal(handler.activeConnectionCount(), 0);
      assert.equal(target.eventStream.listenerCount(), 0);
      assert.equal(request.listenerCount('aborted'), 0);
      assert.equal(response.listenerCount('drain'), 0);
      assert.equal(response.listenerCount('close'), 0);
      assert.equal(response.listenerCount('error'), 0);
    }
    handler.close();
  } finally {
    await target.close();
  }
});

test('server.close 会先关闭 SSE 并完成订阅清理', async () => {
  const target = await harness();
  const connection = openSse(target.port);
  const response = await connection.response;
  assert.equal(target.eventStream.listenerCount(), 1);

  await target.close();

  assert.equal(response.destroyed, true);
  assert.equal(target.eventStream.listenerCount(), 0);
});
