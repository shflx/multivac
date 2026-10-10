import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ASSISTANT_SSE_EVENT_NAME, GLOBAL_ASSISTANT_SESSION_ID, WORKBENCH_SSE_EVENT_NAME, type AssistantPublicEvent } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { openEventStream } from './fixtures/sse-client.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

const token = 'fixture-token-with-more-than-32-bytes';
const origin = 'https://remote.example';
const config = { enabled: true, token, origin, host: '0.0.0.0' };
function http(port: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, incoming => {
      const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: text ? JSON.parse(text) : undefined }); });
    });
    outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture() {
  const base = resolve('.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'remote-http-'));
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1',
    MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: token, MULTIVAC_REMOTE_ORIGIN: origin });
  await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address(); assert.ok(address && typeof address === 'object');
  const port = address.port;
  const login = async (value = token) => {
    const result = await http(port, '/api/access/login', 'POST', { token: value }, { host: 'remote.example', origin });
    const raw = result.headers['set-cookie'];
    return { ...result, cookie: (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] ?? '' };
  };
  const remote = (cookie = '') => ({ host: 'remote.example', origin, ...(cookie ? { cookie } : {}) });
  return { app, port, login, remote, async close() { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('远程HTTP：未登录拒绝、token登录、直接越界/正文替换拒绝、本机入口保持', async () => {
  const f = await fixture();
  try {
    assert.equal((await http(f.port, '/api/access', 'GET', undefined, f.remote())).body.authenticated, false);
    assert.equal((await http(f.port, '/api/assistant/session', 'GET', undefined, f.remote())).status, 401);
    assert.equal((await f.login('wrong')).status, 401);
    const login = await f.login(); assert.equal(login.status, 200); assert.ok(login.cookie);
    const headers = f.remote(login.cookie);
    assert.equal((await http(f.port, '/api/assistant/session', 'GET', undefined, headers)).status, 200);
    assert.equal((await http(f.port, '/api/assistant/page-state', 'GET', undefined, headers)).status, 200);
    assert.equal((await http(f.port, '/api/assistant/model-selection', 'GET', undefined, headers)).status, 200);
    // 本机共享草稿引用其他对象时，远程读取不携带该来源，也不修改本机原状态。
    const state = (await http(f.port, '/api/assistant/page-state')).body;
    const foreignQuote = { sourceKind: 'file', sourceSessionId: 'other', sourceFile: { root: '/fixture/foreign', path: 'sensitive.md' }, text: '本机文件引用' };
    assert.equal((await http(f.port, '/api/assistant/page-state', 'PUT', { draft: '', quote: foreignQuote, revision: state.revision, anchorEntryId: null, anchorOffsetPx: 0 })).status, 200);
    assert.equal((await http(f.port, '/api/assistant/page-state', 'GET', undefined, headers)).body.quote, null);
    assert.deepEqual((await http(f.port, '/api/assistant/page-state')).body.quote, foreignQuote);
    for (const path of ['/api/inbox', '/api/tasks', '/api/projects', '/api/preferences', '/api/processes', '/api/reading/books',
      '/api/authorization-grants', '/api/sessions/global-coordinator/session', '/api/sessions/other/session',
      `/api/sessions/other/images/${'a'.repeat(64)}/content`, '/api/sessions/other/files']) {
      assert.equal((await http(f.port, path, 'GET', undefined, headers)).status, 403, path);
    }
    for (const path of ['/api/__e2e/reset', '/api/assistant/model-selection/model']) assert.equal((await http(f.port, path, 'POST', {}, headers)).status, 403, path);
    assert.equal((await http(f.port, '/api/assistant/turns', 'POST', { assistantSessionId: 'other' }, headers)).status, 403);
    assert.equal((await http(f.port, '/api/assistant/turns/current/cancel', 'POST', { assistantSessionId: 'other' }, headers)).status, 403);
    assert.equal((await http(f.port, '/api/assistant/page-state', 'PUT', { quote: { sourceKind: 'file' } }, headers)).status, 403);
    assert.equal((await http(f.port, '/api/assistant/page-state', 'PUT', { quote: { sourceSessionId: 'other' } }, headers)).status, 403);
    assert.equal((await http(f.port, '/api/assistant/turns', 'POST', { currentView: { panel: 'workspace' } }, headers)).status, 403);
    assert.equal((await http(f.port, '/api/assistant/session', 'GET', undefined, { ...headers, origin: 'https://evil.example' })).status, 403);
    assert.equal((await http(f.port, '/api/access/login?token=forbidden', 'POST', { token }, headers)).status, 400);
    // 默认local入口仍由真实回环对端和原本地Host/Origin判断，范围外接口本机可用。
    assert.equal((await http(f.port, '/api/tasks')).status, 200);
    assert.equal((await http(f.port, '/api/inbox')).status, 200);
    assert.equal((await http(f.port, '/api/access')).body.kind, 'local');
  } finally { await f.close(); }
});

test('远程HTTP/SSE：实时与回放/JSON补漏一致，退出/轮换/关闭使既有连接及旧cookie失效', async () => {
  const f = await fixture(); const streams: Array<ReturnType<typeof openEventStream>> = [];
  try {
    assert.equal((await http(f.port, '/api/sessions', 'POST', { sessionId: 'remote-other', title: '其他会话' })).status, 201);
    await http(f.port, '/api/sessions/remote-other/session');
    const start = (await http(f.port, '/api/assistant/session')).body.eventCursor as string;
    const produce = async (sessionId: string, label: string) => {
      const result = await http(f.port, '/api/__e2e/assistant/events/body', 'POST', { sessionId, messageId: `remote-${label}`, delta: label });
      assert.equal(result.status, 200); return result.body.cursor as string;
    };
    await produce('remote-other', 'outside-replay'); const first = await produce(GLOBAL_ASSISTANT_SESSION_ID, 'global-replay');
    const login = await f.login(); const headers = f.remote(login.cookie);
    const open = () => { const stream = openEventStream(f.port, `/api/events?after=${start}&windowId=remote-window`, headers); streams.push(stream); return stream; };
    const one = open(); const two = open(); assert.equal((await one.response).status, 200); assert.equal((await two.response).status, 200);
    const local = openEventStream(f.port, `/api/events?after=${start}&windowId=local-window`); streams.push(local); await local.response;
    await produce('remote-other', 'outside-live'); const last = await produce(GLOBAL_ASSISTANT_SESSION_ID, 'global-live');
    await http(f.port, '/api/sessions/remote-other', 'PATCH', { title: '工作台变更' });
    await one.waitFor(messages => messages.filter(item => item.event === ASSISTANT_SSE_EVENT_NAME).length === 2);
    const received = one.named(ASSISTANT_SSE_EVENT_NAME);
    assert.deepEqual(received.map(item => item.id), [first, last]);
    assert.ok(received.every(item => (item.data as AssistantPublicEvent).assistantSessionId === GLOBAL_ASSISTANT_SESSION_ID));
    assert.deepEqual(one.named(WORKBENCH_SSE_EVENT_NAME), []);
    await local.waitFor(messages => messages.some(item => item.event === WORKBENCH_SSE_EVENT_NAME && item.data.type === 'session.changed'));
    assert.ok(local.named(ASSISTANT_SSE_EVENT_NAME).some(item => item.data.assistantSessionId === 'remote-other'));
    const replay = await http(f.port, `/api/assistant/events?after=${start}&until=${last}`, 'GET', undefined, headers);
    assert.deepEqual(replay.body.events.map((event: AssistantPublicEvent) => event.cursor), [first, last]);
    assert.equal((await http(f.port, '/api/access/logout', 'POST', undefined, headers)).status, 200);
    await Promise.all([one.waitForEnd(), two.waitForEnd()]); assert.equal(local.isEnded(), false);
    assert.equal((await http(f.port, '/api/assistant/session', 'GET', undefined, headers)).status, 401);
    const oldReconnect = openEventStream(f.port, `/api/events?after=${last}`, headers); streams.push(oldReconnect); assert.equal((await oldReconnect.response).status, 401);
    const rotatedLogin = await f.login(); const rotated = openEventStream(f.port, `/api/events?after=${last}`, f.remote(rotatedLogin.cookie)); streams.push(rotated); await rotated.response;
    f.app.remoteAccess.configure({ ...config, token: `${token}-new` }); await rotated.waitForEnd();
    assert.equal((await http(f.port, '/api/assistant/session', 'GET', undefined, f.remote(rotatedLogin.cookie))).status, 401);
    assert.equal((await f.login()).status, 401);
    const newLogin = await f.login(`${token}-new`); assert.equal(newLogin.status, 200);
    const closing = openEventStream(f.port, `/api/events?after=${last}`, f.remote(newLogin.cookie)); streams.push(closing); await closing.response;
    f.app.remoteAccess.configure({ ...config, token: `${token}-new`, enabled: false }); await closing.waitForEnd();
    assert.equal((await http(f.port, '/api/access', 'GET', undefined, f.remote(newLogin.cookie))).status, 403);
    assert.equal((await http(f.port, '/api/tasks')).status, 200);
  } finally { for (const stream of streams) stream.close(); await f.close(); }
});
