import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantPublicEvent,
} from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';

function httpJson(
  port: number,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** 订阅某个会话的 SSE，直到收到满足条件的事件为止。 */
function subscribe(port: number, path: string) {
  const events: AssistantPublicEvent[] = [];
  let req!: ClientRequest;
  const waiters: Array<{ predicate: (event: AssistantPublicEvent) => boolean; resolve: () => void }> = [];
  const opened = new Promise<IncomingMessage>((resolve, reject) => {
    req = request({ hostname: '127.0.0.1', port, path, headers: { accept: 'text/event-stream' } }, resolve);
    req.on('error', reject);
    req.end();
  });
  void opened.then((response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as AssistantPublicEvent;
        events.push(event);
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(event)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    });
  });
  return {
    events,
    opened,
    until(predicate: (event: AssistantPublicEvent) => boolean): Promise<void> {
      if (events.some(predicate)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    close() { req.destroy(); },
  };
}

function sendBody(sessionId: string, commandId: string, text: string) {
  return { commandId, assistantSessionId: sessionId, text, contextRefs: [] };
}

test('两个工作会话可同时运行，事件按会话隔离，取消其中一个不影响另一个', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-runtime-'));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const adapter = new FakeCoordinatorAdapter({
    promptCompletionBarrier: barrier,
    seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
  });
  const app = createMultivacApplication(
    { MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' },
    { coordinatorAdapter: adapter },
  );
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const streams: Array<ReturnType<typeof subscribe>> = [];

  try {
    for (const [sessionId, title] of [['work-a', '会话 A'], ['work-b', '会话 B']]) {
      assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId, title })).status, 201);
    }
    const pageA = await httpJson(port, '/api/sessions/work-a/session');
    assert.equal(pageA.status, 200);
    assert.equal(pageA.body.assistantSessionId, 'work-a');
    assert.deepEqual(pageA.body.messages, []);
    const cursor = pageA.body.eventCursor as string;

    const streamA = subscribe(port, `/api/sessions/work-a/events?after=${cursor}`);
    const streamB = subscribe(port, `/api/sessions/work-b/events?after=${cursor}`);
    const streamGlobal = subscribe(port, `/api/assistant/events?after=${cursor}`);
    streams.push(streamA, streamB, streamGlobal);
    await Promise.all(streams.map((stream) => stream.opened));

    // 两个会话同时进入运行，互不阻塞。
    const sendA = httpJson(port, '/api/sessions/work-a/turns', 'POST', sendBody('work-a', 'cmd-a', '会话 A 的任务'));
    const sendB = httpJson(port, '/api/sessions/work-b/turns', 'POST', sendBody('work-b', 'cmd-b', '会话 B 的任务'));
    await Promise.all([
      streamA.until((event) => event.type === 'assistant.run.processing'),
      streamB.until((event) => event.type === 'assistant.run.processing'),
    ]);
    assert.deepEqual(
      adapter.calls.filter((call) => call.method === 'prompt').map((call) => 'assistantSessionId' in call && call.assistantSessionId).sort(),
      ['work-a', 'work-b'],
    );

    // 运行中的会话不能归档；命令对账只在所属会话可见。
    const archiveRunning = await httpJson(port, '/api/sessions/work-b/archive', 'POST');
    assert.equal(archiveRunning.status, 422);
    assert.equal((await httpJson(port, '/api/sessions/work-a/commands/cmd-a')).body.status, 'running');
    assert.equal((await httpJson(port, '/api/sessions/work-b/commands/cmd-a')).body.status, 'unknown');

    // 取消 A 只作用于 A。
    const cancel = await httpJson(port, '/api/sessions/work-a/turns/current/cancel', 'POST', {
      commandId: 'cancel-a', assistantSessionId: 'work-a',
    });
    assert.ok([200, 202].includes(cancel.status));
    assert.deepEqual(
      adapter.calls.filter((call) => call.method === 'abort').map((call) => 'assistantSessionId' in call && call.assistantSessionId),
      ['work-a'],
    );
    const crossCancel = await httpJson(port, '/api/sessions/work-b/turns/current/cancel', 'POST', {
      commandId: 'cancel-cross', assistantSessionId: 'work-a',
    });
    assert.equal(crossCancel.status, 503);
    assert.equal(crossCancel.body.error.code, 'ASSISTANT_SESSION_BINDING_MISMATCH');

    release();
    const [resultA, resultB] = await Promise.all([sendA, sendB]);
    assert.equal(resultA.body.terminalOutcome, 'cancelled');
    assert.equal(resultB.body.terminalOutcome, 'succeeded');
    await Promise.all([
      streamA.until((event) => event.type === 'assistant.run.cancelled'),
      streamB.until((event) => event.type === 'assistant.run.succeeded'),
    ]);

    // 事件不串线：每条流只含本会话事件，全局会话流不含工作会话事件。
    assert.ok(streamA.events.length > 0 && streamA.events.every((event) => event.assistantSessionId === 'work-a'));
    assert.ok(streamB.events.length > 0 && streamB.events.every((event) => event.assistantSessionId === 'work-b'));
    assert.equal(streamGlobal.events.length, 0);
    assert.ok(streamA.events.some((event) => event.type === 'assistant.run.cancelled'));
    assert.ok(streamB.events.some((event) => event.type === 'assistant.run.succeeded'));
    assert.equal(streamB.events.some((event) => event.type === 'assistant.run.cancelled'), false);

    // 各自的历史只含本会话消息；全局会话历史不受影响。
    const historyB = await httpJson(port, '/api/sessions/work-b/session');
    assert.deepEqual(historyB.body.messages.map((message: { text: string }) => message.text), [
      '会话 B 的任务', 'Fake Multivac 已处理当前消息。',
    ]);
    const globalHistory = await httpJson(port, '/api/assistant/session?limit=100');
    assert.equal(globalHistory.body.messages.some((message: { text: string }) => message.text.includes('会话 A')), false);
  } finally {
    release();
    for (const stream of streams) stream.close();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('页面现场与选模按会话读写，不存在或已归档的会话返回 404', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-runtime-state-'));
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  try {
    await httpJson(port, '/api/sessions', 'POST', { sessionId: 'state-a', title: '状态会话' });
    const initial = await httpJson(port, '/api/sessions/state-a/page-state');
    assert.equal(initial.status, 200);
    const saved = await httpJson(port, '/api/sessions/state-a/page-state', 'PUT', {
      draft: '工作会话草稿', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: initial.body.revision,
    });
    assert.equal(saved.status, 200);
    assert.equal((await httpJson(port, '/api/assistant/page-state')).body.draft, '');
    assert.equal((await httpJson(port, '/api/sessions/state-a/page-state')).body.draft, '工作会话草稿');

    // 选模按会话进行：工作会话有自己的选择与 revision，命令的 sessionId 必须一致。
    const options = await httpJson(port, '/api/sessions/state-a/model-selection');
    assert.equal(options.status, 200);
    assert.equal(options.body.selection.sessionId, 'state-a');
    const mismatched = await httpJson(port, '/api/sessions/state-a/model-selection/model', 'POST', {
      commandId: 'select-mismatch', sessionId: GLOBAL_ASSISTANT_SESSION_ID,
      revision: options.body.selection.revision, profileId: 'fixture-anthropic',
    });
    assert.equal(mismatched.status, 400);
    const switched = await httpJson(port, '/api/sessions/state-a/model-selection/model', 'POST', {
      commandId: 'select-a', sessionId: 'state-a',
      revision: options.body.selection.revision, profileId: 'fixture-anthropic',
    });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.selection.profileId, 'fixture-anthropic');
    const globalSelection = await httpJson(port, '/api/assistant/model-selection');
    assert.equal(globalSelection.body.selection.profileId, 'fixture-openai');

    assert.equal((await httpJson(port, '/api/sessions/missing/session')).status, 404);
    await httpJson(port, '/api/sessions/state-a/archive', 'POST');
    assert.equal((await httpJson(port, '/api/sessions/state-a/page-state')).status, 404);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('重启后按会话中断上一进程遗留的回执，不影响其他会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-runtime-restart-'));
  // 模拟上一进程在运行中退出：工作会话已有注册记录与绑定，并留下一条未终结的发送回执。
  const { SqliteAssistantStore } = await import('../src/storage/sqlite-assistant-store.js');
  const { resolveMultivacDataPaths } = await import('../src/storage/data-paths.js');
  const paths = resolveMultivacDataPaths(root);
  const setup = new SqliteAssistantStore(paths.databasePath);
  setup.insertSessionIfAbsent({
    sessionId: 'restart-a', title: '重启会话', kind: 'work', workspaceId: 'default',
    createdAt: '2026-09-25T00:00:00.000Z',
  });
  setup.insertIfAbsent({
    assistantSessionId: 'restart-a', piSessionId: 'pi-fake-restart-a',
    piSessionPath: join(paths.workSessionDir, 'pi-fake-restart-a.jsonl'), updatedAt: '2026-09-25T00:00:00.000Z',
    modelSource: 'base', modelProvider: 'fixture', modelId: 'gpt-fixture', modelProtocol: 'openai-responses',
    modelEndpoint: 'https://fixture.example/v1', modelResolvedEndpoint: 'https://fixture.example/v1',
  });
  setup.createAccepted({
    commandId: 'orphan-a', assistantSessionId: 'restart-a', kind: 'send',
    payloadFingerprint: 'fingerprint', piSessionId: 'pi-fake-restart-a',
  });
  setup.close();

  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  try {
    // 工作会话按需恢复：首次访问前遗留回执保持原样，全局会话照常可用。
    assert.equal((await httpJson(address.port, '/api/assistant/session')).status, 200);
    const inspection = new SqliteAssistantStore(paths.databasePath);
    assert.equal(inspection.listNonTerminal('restart-a').length, 1);
    inspection.close();

    // 首次访问该会话时完成恢复，遗留回执被标记为中断。
    assert.equal((await httpJson(address.port, '/api/sessions/restart-a/session')).status, 200);
    const orphan = await httpJson(address.port, '/api/sessions/restart-a/commands/orphan-a');
    assert.equal(orphan.body.status, 'terminal');
    assert.equal(orphan.body.receipt.error.code, 'COMMAND_INTERRUPTED');
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('全局会话发送时附带焦点会话上下文：服务端读取标题与摘录交给 Pi，无效引用被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-context-'));
  const adapter = new FakeCoordinatorAdapter({
    seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
  });
  const app = createMultivacApplication(
    { MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' },
    { coordinatorAdapter: adapter },
  );
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const sendGlobal = (commandId: string, contextRefs: unknown[]) => httpJson(port, '/api/assistant/turns', 'POST', {
    commandId, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '这个会话下一步做什么？', contextRefs,
  });
  try {
    await httpJson(port, '/api/sessions', 'POST', { sessionId: 'focus-a', title: '梳理导航结构' });
    await httpJson(port, '/api/sessions/focus-a/turns', 'POST', sendBody('focus-a', 'focus-seed', '先看顶栏的信息层级'));

    const sent = await sendGlobal('context-ok', [{ kind: 'workspace-session', sessionId: 'focus-a' }]);
    assert.equal(sent.status, 200);
    const prompt = adapter.calls.filter((call) => call.method === 'prompt' && call.assistantSessionId === GLOBAL_ASSISTANT_SESSION_ID).at(-1);
    assert.ok(prompt && 'context' in prompt && prompt.context);
    assert.equal(prompt.context.sessionId, 'focus-a');
    assert.equal(prompt.context.title, '梳理导航结构');
    assert.match(prompt.context.excerpt, /用户：先看顶栏的信息层级/u);

    // 不带上下文时不附加任何上下文。
    await sendGlobal('context-none', []);
    const plain = adapter.calls.filter((call) => call.method === 'prompt').at(-1);
    assert.ok(plain && !('context' in plain && plain.context));

    // 不存在、已归档、自身或全局会话都会在受理前被拒绝，不建立回执。
    const promptsBefore = adapter.calls.filter((call) => call.method === 'prompt').length;
    for (const [commandId, sessionId] of [
      ['context-missing', 'missing'], ['context-global', GLOBAL_ASSISTANT_SESSION_ID],
    ] as const) {
      const rejected = await sendGlobal(commandId, [{ kind: 'workspace-session', sessionId }]);
      assert.equal(rejected.status, 400, commandId);
      assert.equal((await httpJson(port, `/api/assistant/commands/${commandId}`)).body.status, 'unknown');
    }
    await httpJson(port, '/api/sessions/focus-a/archive', 'POST');
    assert.equal((await sendGlobal('context-archived', [{ kind: 'workspace-session', sessionId: 'focus-a' }])).status, 400);
    // 工作会话本身不接受上下文引用。
    const workWithContext = await httpJson(port, '/api/sessions', 'POST', { sessionId: 'focus-b', title: '另一个会话' })
      .then(() => httpJson(port, '/api/sessions/focus-b/turns', 'POST', {
        ...sendBody('focus-b', 'work-context', '正文'), contextRefs: [{ kind: 'workspace-session', sessionId: 'focus-a' }],
      }));
    assert.equal(workWithContext.status, 400);
    assert.equal(adapter.calls.filter((call) => call.method === 'prompt').length, promptsBefore);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('跨会话引用：服务端核对来源会话与消息归属，来源随消息保存，伪造来源被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-cross-quote-'));
  const adapter = new FakeCoordinatorAdapter({
    seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
  });
  const app = createMultivacApplication(
    { MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' },
    { coordinatorAdapter: adapter },
  );
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  try {
    await httpJson(port, '/api/sessions', 'POST', { sessionId: 'quote-src', title: '导航结构' });
    await httpJson(port, '/api/sessions/quote-src/turns', 'POST', sendBody('quote-src', 'quote-seed', '顶栏怎么设计'));
    const sourcePage = await httpJson(port, '/api/sessions/quote-src/session');
    const reply = sourcePage.body.messages.find((message: { role: string }) => message.role === 'assistant');
    const quote = {
      sourcePiSessionId: sourcePage.body.piSessionId, sourcePiEntryId: reply.piEntryId, sourceRole: 'assistant',
      text: 'Fake Multivac', sourceSessionId: 'quote-src', sourceTitle: '客户端提供的名称',
    };
    const sendQuote = (commandId: string, value: unknown) => httpJson(port, '/api/assistant/turns', 'POST', {
      commandId, assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '这个怎么落地？', contextRefs: [], quote: value,
    });

    const sent = await sendQuote('cross-ok', quote);
    assert.equal(sent.status, 200);
    const prompt = adapter.calls.filter((call) => call.method === 'prompt').at(-1);
    assert.ok(prompt && 'quote' in prompt && prompt.quote?.source);
    // 会话名以注册表为准，不采用客户端提供的名称。
    assert.deepEqual(prompt.quote.source, {
      sessionId: 'quote-src', title: '导航结构', piSessionId: sourcePage.body.piSessionId,
    });

    // 来源随消息保存，刷新后仍能展示“来自「会话名」”。
    const history = await httpJson(port, '/api/assistant/session?limit=100');
    const sentMessage = history.body.messages.findLast((message: { role: string }) => message.role === 'user');
    assert.equal(sentMessage.quote.sourceSessionId, 'quote-src');
    assert.equal(sentMessage.quote.sourceTitle, '导航结构');
    assert.equal(sentMessage.quote.sourcePiSessionId, sourcePage.body.piSessionId);

    // 同一 commandId 换来源判为冲突。
    const conflict = await sendQuote('cross-ok', { ...quote, sourceSessionId: 'other' });
    assert.equal(conflict.status, 409);

    // 伪造来源会话、消息或 Pi session 都在受理前被拒绝。
    for (const [commandId, forged] of [
      ['cross-missing-session', { ...quote, sourceSessionId: 'missing' }],
      ['cross-missing-entry', { ...quote, sourcePiEntryId: 'entry-missing' }],
      ['cross-wrong-pi', { ...quote, sourcePiSessionId: 'pi-forged' }],
      ['cross-no-source', { ...quote, sourceSessionId: undefined }],
    ] as const) {
      const rejected = await sendQuote(commandId, forged);
      assert.equal(rejected.status, 400, commandId);
      assert.equal((await httpJson(port, `/api/assistant/commands/${commandId}`)).body.status, 'unknown');
    }
    await httpJson(port, '/api/sessions/quote-src/archive', 'POST');
    assert.equal((await sendQuote('cross-archived', quote)).status, 400);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('栈式深入：子会话记录父会话与来源，首轮承接父会话背景，父会话不被改写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-stack-'));
  const adapter = new FakeCoordinatorAdapter({
    seedsHistory: (sessionId) => sessionId === GLOBAL_ASSISTANT_SESSION_ID,
  });
  const start = async () => {
    const app = createMultivacApplication(
      { MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' },
      { coordinatorAdapter: adapter },
    );
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    return { port: address.port, app };
  };
  const { port, app } = await start();
  try {
    await httpJson(port, '/api/sessions', 'POST', { sessionId: 'stack-parent', title: '导航结构' });
    await httpJson(port, '/api/sessions/stack-parent/turns', 'POST', sendBody('stack-parent', 'stack-seed', '顶栏只保留两个入口吗'));
    const parentPage = await httpJson(port, '/api/sessions/stack-parent/session');
    const reply = parentPage.body.messages.find((message: { role: string }) => message.role === 'assistant');
    const quote = {
      sourcePiSessionId: parentPage.body.piSessionId, sourcePiEntryId: reply.piEntryId,
      sourceRole: 'assistant', text: '已处理当前消息', sourceSessionId: 'stack-parent',
    };

    const child = await httpJson(port, '/api/sessions', 'POST', {
      sessionId: 'stack-child', title: '已处理当前消息', parent: { sessionId: 'stack-parent', quote },
    });
    assert.equal(child.status, 201);
    assert.equal(child.body.parentSessionId, 'stack-parent');
    assert.equal(child.body.originText, '已处理当前消息');
    // 选中内容作为来自父会话的引用放进子会话输入区。
    const seeded = await httpJson(port, '/api/sessions/stack-child/page-state');
    assert.deepEqual(seeded.body.quote, { ...quote, sourceTitle: '导航结构' });
    // 用户移除引用后，重试新建不会再次写入。
    await httpJson(port, '/api/sessions/stack-child/page-state', 'PUT', {
      draft: '', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: seeded.body.revision,
    });
    // 重试幂等；同 id 换父会话判为冲突。
    assert.equal((await httpJson(port, '/api/sessions', 'POST', {
      sessionId: 'stack-child', title: '已处理当前消息', parent: { sessionId: 'stack-parent', quote },
    })).status, 200);
    assert.equal((await httpJson(port, '/api/sessions/stack-child/page-state')).body.quote, null);
    assert.equal((await httpJson(port, '/api/sessions', 'POST', {
      sessionId: 'stack-child', title: '已处理当前消息',
    })).status, 409);
    // 伪造选中内容或父会话被拒绝。
    for (const [sessionId, parent] of [
      ['stack-forged-entry', { sessionId: 'stack-parent', quote: { ...quote, sourcePiEntryId: 'missing' } }],
      ['stack-forged-parent', { sessionId: 'missing', quote }],
      ['stack-global-parent', { sessionId: GLOBAL_ASSISTANT_SESSION_ID, quote }],
    ] as const) {
      const rejected = await httpJson(port, '/api/sessions', 'POST', { sessionId, title: '伪造', parent });
      assert.equal(rejected.status, 400, sessionId);
    }

    // 子会话首轮附带父会话背景与选中内容；之后的发送不再附带。
    await httpJson(port, '/api/sessions/stack-child/turns', 'POST', sendBody('stack-child', 'child-1', '展开讲讲'));
    const first = adapter.calls.filter((call) => call.method === 'prompt' && call.assistantSessionId === 'stack-child')[0];
    assert.ok(first && 'context' in first && first.context);
    assert.equal(first.context.kind, 'parent-session');
    assert.equal(first.context.title, '导航结构');
    assert.equal(first.context.selection, '已处理当前消息');
    assert.match(first.context.excerpt, /用户：顶栏只保留两个入口吗/u);
    await httpJson(port, '/api/sessions/stack-child/turns', 'POST', sendBody('stack-child', 'child-2', '继续'));
    const second = adapter.calls.filter((call) => call.method === 'prompt' && call.assistantSessionId === 'stack-child')[1];
    assert.ok(second && !('context' in second && second.context));

    // 父会话内容不变，子会话结论不写回。
    const parentAfter = await httpJson(port, '/api/sessions/stack-parent/session');
    assert.deepEqual(parentAfter.body.messages, parentPage.body.messages);

    // 再深入一层：孙会话的父会话是子会话。
    const childPage = await httpJson(port, '/api/sessions/stack-child/session');
    const childReply = childPage.body.messages.find((message: { role: string }) => message.role === 'assistant');
    const grandchild = await httpJson(port, '/api/sessions', 'POST', {
      sessionId: 'stack-grandchild', title: '孙会话', parent: {
        sessionId: 'stack-child', quote: {
          sourcePiSessionId: childPage.body.piSessionId, sourcePiEntryId: childReply.piEntryId,
          sourceRole: 'assistant', text: 'Fake',
        },
      },
    });
    assert.equal(grandchild.status, 201);
    const listed = await httpJson(port, '/api/sessions');
    assert.deepEqual(
      listed.body.sessions.map((session: { sessionId: string; parentSessionId: string | null }) =>
        [session.sessionId, session.parentSessionId]),
      [['stack-parent', null], ['stack-child', 'stack-parent'], ['stack-grandchild', 'stack-child']],
    );
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
  }

  // 重启后栈式关系保留。
  const restarted = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' });
  await restarted.ready;
  await new Promise<void>((resolve) => restarted.server.listen(0, '127.0.0.1', resolve));
  const address = restarted.server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const listed = await httpJson(address.port, '/api/sessions');
    const child = listed.body.sessions.find((session: { sessionId: string }) => session.sessionId === 'stack-child');
    assert.equal(child.parentSessionId, 'stack-parent');
    assert.equal(child.originText, '已处理当前消息');
  } finally {
    await new Promise<void>((resolve) => restarted.server.close(() => resolve()));
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});
