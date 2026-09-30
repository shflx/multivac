import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ASSISTANT_SSE_EVENT_NAME,
  GLOBAL_ASSISTANT_SESSION_ID,
  GLOBAL_EVENTS_PATH,
  WINDOW_ID_HEADER,
  WORKBENCH_SSE_EVENT_NAME,
  type AssistantPublicEvent,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { openEventStream, type SseMessage } from './fixtures/sse-client.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

/**
 * 应用级（Fake、临时目录环境）：两个会话与全局 Multivac 交替产生事件，窗口的一条全局事件流按游标顺序收到全部事件，
 * 同时收到工作台变更；测试控制路由断开事件流后按游标续传不漏不重；补漏读取只取某个会话的一段。
 */

function httpJson(
  port: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

const sessionEvents = (messages: SseMessage[]) => messages.filter((message) => message.event === ASSISTANT_SSE_EVENT_NAME);

test('HTTP（Fake）：全局事件流按游标顺序收到两个会话交替产生的全部事件与工作台变更，断开后按游标续传不漏不重', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-global-events-http-'));
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' });
  await app.ready;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as { port: number };
  const streams: Array<ReturnType<typeof openEventStream>> = [];
  try {
    for (const sessionId of ['work-a', 'work-b']) {
      assert.equal((await httpJson(port, '/api/sessions', 'POST', { sessionId, title: sessionId })).status, 201);
      assert.equal((await httpJson(port, `/api/sessions/${sessionId}/session`)).status, 200);
    }
    const start = (await httpJson(port, '/api/assistant/session')).body.eventCursor as string;

    // 经测试控制路由产生正文增量（与真实流式输出同一条写入与发布路径），记下各自的 cursor。
    const produced: Array<{ sessionId: string; cursor: string }> = [];
    const produce = async (sessionId: string) => {
      const response = await httpJson(port, '/api/__e2e/assistant/events/body', 'POST', {
        sessionId, messageId: `m-${sessionId}`, delta: `${sessionId} 的第 ${produced.length + 1} 段`,
      });
      assert.equal(response.status, 200);
      produced.push({ sessionId, cursor: response.body.cursor as string });
    };
    const alternate = ['work-a', 'work-b', GLOBAL_ASSISTANT_SESSION_ID, 'work-b', 'work-a'];

    // 连接前产生的事件（回放）与连接后产生的事件（实时）。
    for (const sessionId of alternate) await produce(sessionId);
    const stream = openEventStream(port, `${GLOBAL_EVENTS_PATH}?after=${start}&windowId=window-a`);
    streams.push(stream);
    assert.equal((await stream.response).status, 200);
    for (const sessionId of alternate) await produce(sessionId);
    await stream.waitFor((messages) => sessionEvents(messages).length === produced.length, '全部会话事件');

    const received = sessionEvents(stream.messages);
    assert.deepEqual(received.map((message) => message.id), produced.map((item) => item.cursor));
    assert.deepEqual(
      received.map((message) => (message.data as AssistantPublicEvent).assistantSessionId),
      produced.map((item) => item.sessionId),
    );

    // 工作台变更走同一条流：先有连接事件，别的窗口改名后收到会话变更（不带游标）。
    const renamed = await httpJson(port, '/api/sessions/work-a', 'PATCH', { title: '接口调研' }, { [WINDOW_ID_HEADER]: 'window-b' });
    assert.equal(renamed.status, 200);
    await stream.waitFor((messages) => messages.some((message) =>
      message.event === WORKBENCH_SSE_EVENT_NAME && message.data.type === 'session.changed'), '会话变更');
    const workbench = stream.messages.filter((message) => message.event === WORKBENCH_SSE_EVENT_NAME);
    assert.deepEqual(workbench.map((message) => (message.data as WorkbenchEvent).type), ['workbench.connected', 'session.changed']);
    assert.equal(workbench.every((message) => message.id === undefined), true);
    assert.deepEqual(stream.messages[0]!.data.windowId, 'window-a');

    // 测试控制路由断开事件流（模拟网络中断）；断开期间的事件在续传时补齐，已收到的不重复。
    const disconnected = await httpJson(port, '/api/__e2e/events/disconnect', 'POST');
    assert.deepEqual(disconnected.body, { disconnected: 1 });
    await stream.waitForEnd();
    const lastReceived = received.at(-1)!.id!;
    const beforeGap = produced.length;
    await produce('work-b');
    await produce('work-a');
    const resumed = openEventStream(port, `${GLOBAL_EVENTS_PATH}?after=${lastReceived}&windowId=window-a`);
    streams.push(resumed);
    await produce(GLOBAL_ASSISTANT_SESSION_ID);
    await resumed.waitFor((messages) => sessionEvents(messages).length === produced.length - beforeGap, '续传');
    assert.deepEqual(sessionEvents(resumed.messages).map((message) => message.id), produced.slice(beforeGap).map((item) => item.cursor));

    // 补漏读取：只取 work-a 在 (start, 最后一条] 之间的事件，只读。
    const range = await httpJson(port, `/api/sessions/work-a/events?after=${start}&until=${produced.at(-1)!.cursor}`);
    assert.equal(range.status, 200);
    assert.deepEqual(
      range.body.events.map((event: AssistantPublicEvent) => event.cursor),
      produced.filter((item) => item.sessionId === 'work-a').map((item) => item.cursor),
    );
    assert.equal(range.body.hasMore, false);
  } finally {
    for (const stream of streams) stream.close();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await rm(root, { recursive: true, force: true });
  }
});
