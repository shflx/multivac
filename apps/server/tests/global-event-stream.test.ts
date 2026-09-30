import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  ASSISTANT_EVENT_REPLAY_MAX_LIMIT,
  ASSISTANT_SSE_EVENT_NAME,
  AssistantEventRangeResponseSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  WORKBENCH_SSE_EVENT_NAME,
  WorkbenchEventSchema,
  type AssistantPublicEvent,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import {
  AssistantSessionServiceError,
  type AssistantSessionService,
} from '../src/application/assistant-session-service.js';
import type { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { createMultivacHttpServer } from '../src/bootstrap/server.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantEventRepository,
  SqliteAssistantStore,
} from '../src/storage/sqlite-assistant-store.js';
import { openEventStream, type SseMessage } from './fixtures/sse-client.js';

/**
 * 全局事件流 `GET /api/events`：跨会话按游标回放再接实时、不漏不重；工作台变更不带游标、不回放，
 * 以窗口 id 登记（同一窗口可有多条连接）、定向推送只到对应窗口、断开后判定为离线；背压断开；游标过期与参数校验；
 * 以及按会话的补漏读取 `GET /api/sessions/:id/events?after=&until=`。
 */

const SESSIONS = [GLOBAL_ASSISTANT_SESSION_ID, 'work-a', 'work-b'];

async function harness(limits: { maxQueuedEvents?: number; maxQueuedBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-global-events-'));
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const eventRepository = new SqliteAssistantEventRepository(store);
  // 事件按会话绑定外键约束：先为三个会话写入绑定。
  const bindings = new SqliteAssistantBindingRepository(store);
  for (const sessionId of SESSIONS) {
    bindings.insertIfAbsent({
      assistantSessionId: sessionId, piSessionId: `pi-${sessionId}`,
      piSessionPath: join(root, `${sessionId}.jsonl`), updatedAt: '2026-09-30T08:00:00.000Z',
    });
  }
  const eventStream = new AssistantEventStream();
  const workbench = new WorkbenchEvents();
  // 事件流与补漏读取只用到事件仓库；会话服务不会被调用。
  const unused = {} as AssistantSessionService & AssistantTurnCommandService;
  const server = createMultivacHttpServer({
    service: unused,
    commandService: unused,
    eventRepository,
    eventStream,
    workbenchEvents: workbench,
    ...limits,
    resolveSession: (sessionId) => {
      if (!SESSIONS.includes(sessionId)) throw new AssistantSessionServiceError('NOT_FOUND', '会话不存在或已归档。');
      return { service: unused, commandService: unused };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let sequence = 0;

  /** 写入一条会话事件；live 时同时发布到实时事件流（与服务提交后发布一致）。 */
  const append = (sessionId: string, live: boolean, delta = `片段 ${sequence}`): AssistantPublicEvent => {
    sequence += 1;
    const event = eventRepository.append({
      sourceKey: `test:${sequence}`, assistantSessionId: sessionId, commandId: null,
      type: 'assistant.message.delta', data: { piSessionId: `pi-${sessionId}`, messageId: `m-${sessionId}`, delta },
      occurredAt: '2026-09-30T08:00:00.000Z',
    })!;
    if (live) eventStream.publish(event);
    return event;
  };

  return {
    root, port, eventRepository, eventStream, workbench, append,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function httpJson(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const sessionEvents = (messages: SseMessage[]) => messages.filter((message) => message.event === ASSISTANT_SSE_EVENT_NAME);
const workbenchEvents = (messages: SseMessage[]) => messages
  .filter((message) => message.event === WORKBENCH_SSE_EVENT_NAME)
  .map((message) => message.data as WorkbenchEvent);
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const sceneChange = (revision: number) => ({
  type: 'scene.changed' as const,
  origin: { windowId: null, commandId: 'turn-1' },
  scene: {
    workspaceId: 'default',
    scene: { parallelCount: 2 as const, slots: [], focusedSessionId: null, viewMode: 'parallel' as const, widths: {}, barVisible: true },
    revision,
  },
});
const navigate = {
  type: 'window.navigate' as const,
  origin: { windowId: 'window-a', commandId: 'turn-2' },
  target: { kind: 'management' as const, page: 'models' as const, selection: null },
};

test('全局事件流：跨会话按游标顺序分页回放，再接实时事件；回放与实时衔接不漏不重', async () => {
  const target = await harness({ maxQueuedEvents: 10_000, maxQueuedBytes: 16 * 1024 * 1024 });
  try {
    // 连接前已有超过一页的事件，三个会话交替产生。
    const before = Array.from({ length: ASSISTANT_EVENT_REPLAY_MAX_LIMIT + 120 }, (_, index) =>
      target.append(SESSIONS[index % 3]!, false));
    const after = before[9]!.cursor;

    const stream = openEventStream(target.port, `/api/events?after=${after}&windowId=window-a`);
    assert.equal((await stream.response).status, 200);
    // 实时事件：交替的新事件，以及一条回放中已经发过的旧事件（重复发布不得重复送达）。
    const live = [target.append('work-b', true), target.append(GLOBAL_ASSISTANT_SESSION_ID, true)];
    target.eventStream.publish(before[20]!);
    live.push(target.append('work-a', true), target.append('work-b', true));

    const expected = [...before.slice(10), ...live];
    await stream.waitFor((messages) => sessionEvents(messages).length >= expected.length, '回放与实时事件');
    await settle();
    const received = sessionEvents(stream.messages);
    assert.deepEqual(received.map((message) => message.id), expected.map((event) => event.cursor));
    assert.deepEqual(received.map((message) => message.data), expected);
    assert.deepEqual([...new Set(received.map((message) => message.data.assistantSessionId))].sort(), [...SESSIONS].sort());

    // 第一条消息是工作台的连接事件：登记的窗口，不带游标。
    assert.equal(stream.messages[0]!.event, WORKBENCH_SSE_EVENT_NAME);
    assert.equal(stream.messages[0]!.id, undefined);
    assert.deepEqual({ ...stream.messages[0]!.data, seq: 0 }, { type: 'workbench.connected', seq: 0, windowId: 'window-a' });
    stream.close();
  } finally {
    await target.close();
  }
});

test('全局事件流：工作台变更不回放、不带游标；定向推送只到对应窗口的每条连接；连接全部断开后窗口判定为离线', async () => {
  const target = await harness();
  try {
    // 连接前发布的变更不会被补发。
    target.workbench.publish(sceneChange(1));
    const a = openEventStream(target.port, '/api/events?after=0&windowId=window-a');
    // 同一窗口的第二条连接（例如断线重连时旧连接尚未注销）。
    const aAgain = openEventStream(target.port, '/api/events?after=0&windowId=window-a');
    const b = openEventStream(target.port, '/api/events?after=0&windowId=window-b');
    const anonymous = openEventStream(target.port, '/api/events');
    for (const stream of [a, aAgain, b, anonymous]) {
      await stream.waitFor((messages) => workbenchEvents(messages).some((event) => event.type === 'workbench.connected'), '连接事件');
    }
    await settle();
    assert.equal(target.workbench.hasWindow('window-a'), true);
    assert.equal(target.workbench.hasWindow('window-b'), true);

    // 广播：各连接都收到；与会话事件交错时顺序保持。
    target.workbench.publish(sceneChange(2));
    const cursor = target.append('work-a', true).cursor;
    // 定向：只有以 window-a 登记的连接（两条）收到；指定投递范围发布的变更同样只到 window-a。
    assert.equal(target.workbench.publishToWindow('window-a', navigate), true);
    target.workbench.publish(sceneChange(3), { targetWindowId: 'window-a' });
    for (const stream of [a, aAgain, b, anonymous]) {
      await stream.waitFor((messages) => sessionEvents(messages).length === 1, '会话事件');
    }
    for (const stream of [a, aAgain]) {
      await stream.waitFor((messages) => workbenchEvents(messages).some((event) =>
        event.type === 'scene.changed' && event.scene.revision === 3), '定向变更');
    }
    await settle();

    const summary = (messages: SseMessage[]) => messages.map((message) =>
      message.event === ASSISTANT_SSE_EVENT_NAME ? `session:${message.id}` : `${message.data.type}:${message.id ?? '-'}`);
    const toWindowA = ['workbench.connected:-', 'scene.changed:-', `session:${cursor}`, 'window.navigate:-', 'scene.changed:-'];
    assert.deepEqual(summary(a.messages), toWindowA);
    assert.deepEqual(summary(aAgain.messages), toWindowA);
    assert.deepEqual(summary(b.messages), ['workbench.connected:-', 'scene.changed:-', `session:${cursor}`]);
    assert.deepEqual(summary(anonymous.messages), ['workbench.connected:-', 'scene.changed:-', `session:${cursor}`]);
    assert.equal(workbenchEvents(anonymous.messages)[0]!.type === 'workbench.connected' &&
      workbenchEvents(anonymous.messages)[0]!.windowId, null);
    for (const event of workbenchEvents(a.messages)) assert.equal(Check(WorkbenchEventSchema, event), true);

    // 连接断开后注销；同一窗口还有连接时仍算在线，全部断开后离线，定向推送不再送达、不改为广播。
    b.close();
    a.close();
    await settle();
    assert.equal(target.workbench.hasWindow('window-b'), false);
    assert.equal(target.workbench.publishToWindow('window-b', navigate), false);
    assert.equal(target.workbench.hasWindow('window-a'), true);
    assert.equal(target.workbench.listenerCount(), 2);
    aAgain.close();
    await settle();
    assert.equal(target.workbench.hasWindow('window-a'), false);
    assert.equal(target.workbench.publishToWindow('window-a', navigate), false);
    await settle();
    assert.equal(workbenchEvents(anonymous.messages).some((event) => event.type === 'window.navigate'), false);

    anonymous.close();
    await settle();
    assert.equal(target.workbench.listenerCount(), 0);
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});

test('全局事件流：积压超过上限时直接断开并注销窗口，之后按最后收到的游标续传', async () => {
  const target = await harness({ maxQueuedBytes: 400 });
  try {
    const first = target.append('work-a', false);
    const stream = openEventStream(target.port, '/api/events?after=0&windowId=window-a');
    await stream.waitFor((messages) => sessionEvents(messages).length === 1, '回放');
    assert.equal(target.workbench.hasWindow('window-a'), true);

    // 一条放不进积压上限的事件：连接断开，订阅与窗口登记随之清理。
    const large = target.append('work-b', true, 'x'.repeat(600));
    await stream.waitForEnd();
    await settle();
    assert.equal(target.workbench.hasWindow('window-a'), false);
    assert.equal(target.workbench.listenerCount(), 0);
    assert.equal(target.eventStream.listenerCount(), 0);
    assert.deepEqual(sessionEvents(stream.messages).map((message) => message.id), [first.cursor]);

    // 续传：从最后收到的游标重连，断开期间的事件由补漏读取取回（这条超过了积压上限，流里仍放不下）。
    const range = await httpJson(target.port, `/api/sessions/work-b/events?after=${first.cursor}&until=${large.cursor}`);
    assert.deepEqual(range.body.events.map((event: AssistantPublicEvent) => event.cursor), [large.cursor]);
    const small = target.append('work-a', false);
    const resumed = openEventStream(target.port, `/api/events?after=${large.cursor}&windowId=window-a`);
    await resumed.waitFor((messages) => sessionEvents(messages).length === 1, '续传');
    assert.deepEqual(sessionEvents(resumed.messages).map((message) => message.id), [small.cursor]);
    resumed.close();
  } finally {
    await target.close();
  }
});

test('全局事件流：游标过期在开流前返回 409；after 缺失从头回放；参数非法 400；非本地来源 403', async () => {
  const target = await harness();
  try {
    const events = [target.append('work-a', false), target.append('work-b', false), target.append('work-a', false)];

    // after 缺失时与按会话事件流一致：从 0 开始；Last-Event-ID 头等同 after。
    const fromStart = openEventStream(target.port, '/api/events');
    await fromStart.waitFor((messages) => sessionEvents(messages).length === 3, '从头回放');
    assert.deepEqual(sessionEvents(fromStart.messages).map((message) => message.id), events.map((event) => event.cursor));
    fromStart.close();
    const byHeader = openEventStream(target.port, '/api/events', { 'last-event-id': events[1]!.cursor });
    await byHeader.waitFor((messages) => sessionEvents(messages).length === 1, '按头续传');
    assert.equal(sessionEvents(byHeader.messages)[0]!.id, events[2]!.cursor);
    byHeader.close();

    for (const path of [
      '/api/events?after=abc',
      '/api/events?after=1&after=2',
      '/api/events?after=01',
      '/api/events?windowId=bad%20id',
      '/api/events?windowId=a&windowId=b',
      '/api/events?after=0&other=1',
    ]) {
      const response = await httpJson(target.port, path);
      assert.equal(response.status, 400, path);
      assert.equal(response.body.error.code, 'INVALID_REQUEST', path);
    }
    const conflict = await httpJson(target.port, '/api/events?after=1', { 'last-event-id': '2' });
    assert.equal(conflict.status, 400);
    assert.equal((await httpJson(target.port, '/api/events', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await httpJson(target.port, '/api/events', { host: 'evil.example' })).status, 403);

    const ahead = await httpJson(target.port, '/api/events?after=999999&windowId=window-a');
    assert.equal(ahead.status, 409);
    assert.equal(ahead.body.error.code, 'EVENT_CURSOR_EXPIRED');
    const inspection = new DatabaseSync(join(target.root, 'data.sqlite'));
    inspection.prepare('DELETE FROM assistant_event_projection WHERE cursor <= ?').run(Number(events[1]!.cursor));
    inspection.close();
    const trimmed = await httpJson(target.port, '/api/events?after=0&windowId=window-a');
    assert.equal(trimmed.status, 409);
    assert.deepEqual(trimmed.body, {
      error: { code: 'EVENT_CURSOR_EXPIRED', message: '公共事件游标已失效，需要重新读取会话快照。' },
    });

    await settle();
    // 被拒绝的请求不登记窗口、不留订阅。
    assert.equal(target.workbench.hasWindow('window-a'), false);
    assert.equal(target.workbench.listenerCount(), 0);
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});

test('补漏读取：按会话读取 (after, until] 区间，分页与上限，参数校验（不带 until 的旧订阅请求 400），游标过期 409', async () => {
  const target = await harness();
  try {
    const events = Array.from({ length: 12 }, (_, index) => target.append(SESSIONS[index % 3]!, false));
    const cursorOf = (index: number) => events[index]!.cursor;
    const ofSession = (sessionId: string, from: number, to: number) => events
      .filter((event) => event.assistantSessionId === sessionId &&
        Number(event.cursor) > Number(cursorOf(from)) && Number(event.cursor) <= Number(cursorOf(to)));

    // 区间两端：after 不含、until 含；只有这个会话的事件。
    const range = await httpJson(target.port, `/api/sessions/work-a/events?after=${cursorOf(1)}&until=${cursorOf(10)}`);
    assert.equal(range.status, 200);
    assert.equal(Check(AssistantEventRangeResponseSchema, range.body), true);
    assert.deepEqual(range.body, { events: ofSession('work-a', 1, 10), hasMore: false });
    assert.equal(range.body.events.at(-1).cursor, cursorOf(10));

    // 分页：hasMore 时以本页最后一条作为 after 继续，拼起来等于整个区间；恰好取完时 hasMore 为 false。
    const pages: AssistantPublicEvent[][] = [];
    let after = '0';
    for (;;) {
      const page = await httpJson(target.port, `/api/sessions/work-b/events?after=${after}&until=${cursorOf(11)}&limit=2`);
      pages.push(page.body.events);
      if (!page.body.hasMore) break;
      after = page.body.events.at(-1).cursor;
    }
    assert.deepEqual(pages.map((page) => page.length), [2, 2]);
    assert.deepEqual(pages.flat(), events.filter((event) => event.assistantSessionId === 'work-b'));

    // 全局 Multivac 用 /api/assistant 前缀；空区间返回空列表。
    const global = await httpJson(target.port, `/api/assistant/events?after=0&until=${cursorOf(11)}`);
    assert.deepEqual(global.body.events, events.filter((event) => event.assistantSessionId === GLOBAL_ASSISTANT_SESSION_ID));
    assert.deepEqual((await httpJson(target.port, `/api/sessions/work-a/events?after=${cursorOf(4)}&until=${cursorOf(4)}`)).body,
      { events: [], hasMore: false });

    for (const query of [
      `until=${cursorOf(3)}`,
      `after=${cursorOf(4)}&until=${cursorOf(3)}`,
      'after=0&until=abc',
      'after=0&until=5&limit=0',
      `after=0&until=5&limit=${ASSISTANT_EVENT_REPLAY_MAX_LIMIT + 1}`,
      'after=0&until=5&until=6',
      'after=0&until=5&windowId=window-a',
    ]) {
      const response = await httpJson(target.port, `/api/sessions/work-a/events?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.error.code, 'INVALID_REQUEST', query);
    }
    // 这条路径不再提供按会话的事件流：不带 until 的请求（原来的订阅方式，含 Last-Event-ID）一律 400，不开流、不订阅。
    for (const [path, headers] of [
      ['/api/sessions/work-a/events', {}],
      ['/api/sessions/work-a/events?after=0', { accept: 'text/event-stream' }],
      ['/api/assistant/events?after=0', { accept: 'text/event-stream' }],
      ['/api/assistant/events', { accept: 'text/event-stream', 'last-event-id': cursorOf(1) }],
    ] as const) {
      const response = await httpJson(target.port, path, headers);
      assert.equal(response.status, 400, path);
      assert.equal(response.body.error.code, 'INVALID_REQUEST', path);
      assert.match(response.body.error.message, /\/api\/events/u, path);
    }
    assert.equal((await httpJson(target.port, '/api/sessions/missing/events?after=0&until=1')).status, 404);
    const expired = await httpJson(target.port, '/api/sessions/work-a/events?after=999999&until=1000000');
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, 'EVENT_CURSOR_EXPIRED');
    assert.equal(target.eventStream.listenerCount(), 0);
  } finally {
    await target.close();
  }
});
