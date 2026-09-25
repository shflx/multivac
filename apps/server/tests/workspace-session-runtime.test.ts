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
