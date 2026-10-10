// 不派生子进程、不使用网络的原生验证；缺少 npm 依赖时也能验证独立安全模块。
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'artifacts');
const results = [];
// 仅 SSE 的数值/名称契约需要运行时包。从本目录真实源码提取这些 literal；
// WindowId 校验使用明确的测试替身，本脚本不宣称完成共享 schema 或 HTTP 集成测试。
const contracts = readdirSync(join(root, 'packages/contracts/src')).filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(join(root, 'packages/contracts/src', name), 'utf8')).join('\n');
const names = ['ASSISTANT_EVENT_REPLAY_MAX_LIMIT', 'ASSISTANT_SSE_EVENT_NAME', 'GLOBAL_EVENTS_PATH', 'WORKBENCH_SSE_EVENT_NAME'];
const declarations = names.map(name => {
  const match = new RegExp(`export const ${name} = ([^;]+);`, 'u').exec(contracts);
  assert.ok(match, `缺少契约 literal: ${name}`);
  assert.match(match[1], /^(?:[0-9_]+|'[^']*')$/u);
  return `export const ${name} = ${match[1]};`;
}).join('\n');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@multivac/contracts') return { url: 'remote-fixture:contracts', shortCircuit: true };
    if (specifier === 'typebox/value') return { url: 'remote-fixture:check', shortCircuit: true };
    if (specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(root).href)) {
      const url = new URL(specifier.replace(/\.js$/u, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'remote-fixture:contracts') return { format: 'module', source: `${declarations}\nexport const WindowIdSchema = {};`, shortCircuit: true };
    if (url === 'remote-fixture:check') return { format: 'module', source: 'export const Check = (_, value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);', shortCircuit: true };
    if (url.startsWith(pathToFileURL(root).href) && url.endsWith('.ts')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const { RemoteAccess, remoteConfigFromEnvironment, REMOTE_COOKIE } = await import('../apps/server/src/adapters/http/remote-access.ts');
const { remoteRouteAllowed, remoteBodyAllowed } = await import('../apps/server/src/adapters/http/remote-policy.ts');
const { createWebAssetsHandler } = await import('../apps/server/src/adapters/http/web-assets.ts');
const { streamPublicEvents, createSseConnection } = await import('../apps/server/src/adapters/http/sse-connection.ts');
const { createEventStreamRequestHandler } = await import('../apps/server/src/adapters/http/event-stream-routes.ts');

const token = 'test-only-token-with-at-least-32-bytes';
const config = { enabled: true, token, origin: 'https://multivac.example', host: '0.0.0.0' };
function request({ method = 'GET', path = '/api/access', host = 'multivac.example', origin, cookie, address = '192.0.2.10', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
  req.method = method; req.url = path; req.headers = { host };
  if (origin !== undefined) req.headers.origin = origin;
  if (cookie !== undefined) req.headers.cookie = cookie;
  if (body !== undefined) req.headers['content-type'] = 'application/json';
  req.socket = { remoteAddress: address };
  return req;
}
class Response extends EventEmitter {
  headers = {}; status = 0; chunks = []; destroyed = false; writableEnded = false; headersSent = false;
  setHeader(name, value) { this.headers[name] = value; }
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; return this; }
  flushHeaders() {}
  write(data) { this.chunks.push(String(data)); return true; }
  end(data) { if (data !== undefined && data !== null) this.chunks.push(String(data)); this.writableEnded = true; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
}
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.log(`FAIL ${name}: ${String(error)}`); }
}
async function login(auth, overrides = {}) {
  const req = request({ method: 'POST', path: '/api/access/login', origin: config.origin, body: { token }, ...overrides });
  const res = new Response(); const identity = auth.identify(req); assert.ok(identity);
  await auth.handle(req, res, identity);
  return { res, cookie: res.headers['set-cookie']?.split(';')[0] };
}

await test('最长有效 token 经过 JSON 转义后仍可登录', async () => {
  for (const value of ['"'.repeat(4096), '\u0001'.repeat(4096)]) {
    const auth = new RemoteAccess({ ...config, token: value });
    try { assert.equal((await login(auth, { body: { token: value } })).res.status, 200); }
    finally { auth.close(); }
  }
});

await test('关闭不再接受新请求或已开始读取正文的登录', async () => {
  const auth = new RemoteAccess(config);
  const req = request({ method: 'POST', path: '/api/access/login', origin: config.origin, body: { token } });
  const identity = auth.identify(req); assert.ok(identity);
  const res = new Response(); const pending = auth.handle(req, res, identity);
  auth.close(); await pending;
  assert.equal(res.status, 403); assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(auth.identify(request()), null);
});

await test('外部访问默认关闭且本机配置仍可用', () => {
  const auth = new RemoteAccess(remoteConfigFromEnvironment({}));
  assert.equal(auth.identify(request()), null);
  assert.equal(auth.identify(request({ host: '127.0.0.1:4317', address: '127.0.0.1' })).kind, 'local'); auth.close();
});
await test('启用无效 token、origin、flag 时拒绝配置', () => {
  for (const environment of [{ MULTIVAC_REMOTE_ENABLED: '1' }, { MULTIVAC_REMOTE_ENABLED: 'yes' },
    { MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: token, MULTIVAC_REMOTE_ORIGIN: 'https://multivac.example/' },
    { MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: token, MULTIVAC_REMOTE_ORIGIN: 'https://u:p@multivac.example' }]) assert.throws(() => remoteConfigFromEnvironment(environment));
});
await test('Host/Origin 必须精确同源，伪造 localhost 与转发头不能提升权限', () => {
  const auth = new RemoteAccess(config);
  assert.equal(auth.identify(request({ host: 'localhost:4317' })), null);
  assert.equal(auth.identify(request({ origin: 'https://evil.example' })), null);
  assert.equal(auth.identify(request({ method: 'POST' })), null);
  const req = request(); req.headers['x-forwarded-for'] = '127.0.0.1'; req.headers['x-forwarded-host'] = 'localhost';
  assert.equal(auth.identify(req).kind, 'remote'); assert.equal(auth.identify(req).authenticated, false); auth.close();
});
await test('同源 token 登录换取不包含 token 的 HttpOnly Secure Strict cookie', async () => {
  const auth = new RemoteAccess(config); const { res, cookie } = await login(auth);
  assert.equal(res.status, 200); assert.match(res.headers['set-cookie'], /HttpOnly; SameSite=Strict/u); assert.match(res.headers['set-cookie'], /; Secure$/u);
  assert.ok(!res.headers['set-cookie'].includes(token)); assert.ok(!res.chunks.join('').includes(token));
  assert.equal(auth.identify(request({ cookie })).authenticated, true); auth.close();
});
await test('错误 token 不创建登录', async () => {
  const auth = new RemoteAccess(config); const { res } = await login(auth, { body: { token: 'wrong' } });
  assert.equal(res.status, 401); assert.equal(res.headers['set-cookie'], undefined); auth.close();
});
await test('错误尝试第11次限流，窗口后恢复', async () => {
  let now = 1000; const auth = new RemoteAccess(config, () => now);
  for (let i = 0; i < 10; i++) assert.equal((await login(auth, { body: { token: 'wrong' } })).res.status, 401);
  assert.equal((await login(auth)).res.status, 429); now += 60_001;
  assert.equal((await login(auth)).res.status, 200); auth.close();
});
await test('跨IP全局尝试限流', async () => {
  const auth = new RemoteAccess(config);
  for (let i = 0; i < 100; i++) assert.equal((await login(auth, { address: `192.0.2.${i}`, body: { token: 'wrong' } })).res.status, 401);
  assert.equal((await login(auth, { address: '198.51.100.1' })).res.status, 429); auth.close();
});
await test('重复/畸形 cookie 拒绝，远程 cookie 不转成本机身份', async () => {
  const auth = new RemoteAccess(config); const { cookie } = await login(auth);
  assert.equal(auth.identify(request({ cookie: `${cookie}; ${cookie}` })).authenticated, false);
  assert.equal(auth.identify(request({ cookie: `${REMOTE_COOKIE}=bad` })).authenticated, false);
  assert.equal(auth.identify(request({ host: 'localhost:4317', address: '127.0.0.1', cookie })), null); auth.close();
});
await test('退出撤销当前cookie和多个连接，其他登录保留', async () => {
  const auth = new RemoteAccess(config); const first = await login(auth); const second = await login(auth);
  let closed = 0; const identity = auth.identify(request({ cookie: first.cookie }));
  auth.bind(identity, () => closed++); auth.bind(identity, () => closed++);
  const req = request({ method: 'POST', path: '/api/access/logout', origin: config.origin, cookie: first.cookie }); const res = new Response();
  await auth.handle(req, res, auth.identify(req));
  assert.equal(closed, 2); assert.match(res.headers['set-cookie'], /Max-Age=0/u);
  assert.equal(auth.identify(request({ cookie: first.cookie })).authenticated, false);
  assert.equal(auth.identify(request({ cookie: second.cookie })).authenticated, true); auth.close();
});
await test('token更新立即撤销旧登录/连接，旧token不能登录', async () => {
  const auth = new RemoteAccess(config); const { cookie } = await login(auth); let closed = 0;
  auth.bind(auth.identify(request({ cookie })), () => closed++);
  auth.configure({ ...config, token: `${token}-rotated` });
  assert.equal(closed, 1); assert.equal(auth.identify(request({ cookie })).authenticated, false);
  assert.equal((await login(auth)).res.status, 401); assert.equal((await login(auth, { body: { token: `${token}-rotated` } })).res.status, 200); auth.close();
});
await test('关闭外部访问撤销远程登录/连接，本机仍可用', async () => {
  const auth = new RemoteAccess(config); const { cookie } = await login(auth); let closed = 0;
  auth.bind(auth.identify(request({ cookie })), () => closed++); auth.configure({ ...config, enabled: false });
  assert.equal(closed, 1); assert.equal(auth.identify(request({ cookie })), null);
  assert.equal(auth.identify(request({ host: 'localhost:4317', address: '127.0.0.1' })).kind, 'local'); auth.close();
});
await test('到期在读取时撤销连接，绑定已失效身份即时关闭', async () => {
  let now = 1000; const auth = new RemoteAccess(config, () => now); const { cookie } = await login(auth);
  const identity = auth.identify(request({ cookie })); let closed = 0; auth.bind(identity, () => closed++);
  now += 12 * 60 * 60 * 1000; assert.equal(auth.identify(request({ cookie })).authenticated, false);
  assert.equal(closed, 1); auth.bind(identity, () => closed++); assert.equal(closed, 2); auth.close();
});
await test('重启不恢复旧cookie；身份响应不泄露token', async () => {
  const first = new RemoteAccess(config); const { cookie } = await login(first); first.close();
  const second = new RemoteAccess(config); assert.equal(second.identify(request({ cookie })).authenticated, false);
  const req = request(); const res = new Response(); await second.handle(req, res, second.identify(req));
  assert.ok(!res.chunks.join('').includes(token)); second.close();
});
await test('登录正文格式、大小和Content-Type验证', async () => {
  const auth = new RemoteAccess(config);
  assert.equal((await login(auth, { body: { token, extra: 'value' } })).res.status, 400);
  assert.equal((await login(auth, { body: '{broken' })).res.status, 400);
  assert.equal((await login(auth, { body: 'x'.repeat(32 * 1024 + 1) })).res.status, 413);
  const req = request({ method: 'POST', path: '/api/access/login', origin: config.origin, body: { token } }); delete req.headers['content-type'];
  const res = new Response(); await auth.handle(req, res, auth.identify(req)); assert.equal(res.status, 415); auth.close();
});
await test('对话允许清单覆盖读历史/发送/停止/确认/图片/回放', () => {
  for (const [method, path] of [['GET', '/api/assistant/session'], ['PUT', '/api/assistant/page-state'], ['POST', '/api/assistant/turns'],
    ['POST', '/api/assistant/turns/current/cancel'], ['GET', '/api/events'], ['GET', '/api/assistant/events'],
    ['POST', '/api/assistant/authorizations/request-1/decision'], ['POST', '/api/assistant/proposals/proposal-1/decision'],
    ['GET', '/api/assistant/model-selection'], ['GET', '/api/assistant/confirmations'],
    ['POST', '/api/assistant/confirmations/external%3Aabc/decision'], ['POST', '/api/sessions/global-coordinator/images'],
    ['GET', `/api/sessions/global-coordinator/images/${'a'.repeat(64)}/content`]]) assert.equal(remoteRouteAllowed(method, path), true, path);
});
await test('管理/其他会话/方法/资源路径/编码绕过默认拒绝', () => {
  for (const path of ['/api/inbox', '/api/tasks', '/api/reading/books', '/api/projects', '/api/preferences', '/api/runs', '/api/model-settings',
    '/api/authorization-grants', '/api/authorization-requests', '/api/sessions/other/session', '/api/sessions/global-coordinator/session',
    `/api/sessions/other/images/${'a'.repeat(64)}/content`, '/api/assistant/session/extra', '/api/assistant/proposals/abc%2Fdef/decision',
    '/api/assistant/confirmations/abc%2Fdef/decision', '/api/test/reset']) {
    assert.equal(remoteRouteAllowed('GET', path), false, path); assert.equal(remoteRouteAllowed('POST', path), false, path);
  }
  assert.equal(remoteRouteAllowed('DELETE', '/api/assistant/session'), false);
  assert.equal(remoteRouteAllowed('POST', '/api/assistant/model-selection/model'), false);
});
await test('正文身份、文件/书籍/跨会话引用及视图上下文越界拒绝', () => {
  for (const body of [{ assistantSessionId: 'other' }, { currentView: { panel: 'workspace' } }, { contextRefs: [{ kind: 'task', taskId: 'x' }] },
    { quote: { sourceKind: 'file' } }, { quote: { sourceKind: 'book' } }, { quote: { sourceSessionId: 'other' } }]) assert.equal(remoteBodyAllowed(body), false);
  assert.equal(remoteBodyAllowed({ assistantSessionId: 'global-coordinator', currentView: null, contextRefs: [], quote: null }), true);
  assert.equal(remoteBodyAllowed({ quote: { sourceSessionId: 'global-coordinator', sourceKind: 'message' } }), true);
});

function sourceEvents() {
  const events = Array.from({ length: 1100 }, (_, index) => ({ cursor: String(index + 1), assistantSessionId: index === 1050 ? 'global-coordinator' : 'other', type: 'fixture', data: {} }));
  const listeners = new Set();
  const repository = { listAfter(cursor, limit, sessionId) { return events.filter(event => Number(event.cursor) > Number(cursor) && (!sessionId || event.assistantSessionId === sessionId)).slice(0, limit); } };
  const stream = { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  return { events, listeners, repository, stream };
}
await test('SSE实时与回放只含全局对话，长段其他事件无遗漏/循环', () => {
  const source = sourceEvents(); const chunks = [];
  const release = streamPublicEvents({ send: chunk => chunks.push(chunk), isClosed: () => false }, { initialCursor: '0', eventRepository: source.repository, eventStream: source.stream, sessionId: 'global-coordinator' });
  assert.equal(chunks.length, 1); assert.match(chunks[0], /"cursor":"1051"/u); assert.ok(!chunks.join('').includes('"assistantSessionId":"other"'));
  for (const event of [{ cursor: '1101', assistantSessionId: 'other' }, { cursor: '1102', assistantSessionId: 'global-coordinator' }, { cursor: '1102', assistantSessionId: 'global-coordinator' }]) for (const listener of source.listeners) listener(event);
  assert.equal(chunks.length, 2); release(); assert.equal(source.listeners.size, 0);
});
await test('本机SSE仍含全部会话事件', () => {
  const source = sourceEvents(); const chunks = [];
  const release = streamPublicEvents({ send: chunk => chunks.push(chunk), isClosed: () => false }, { initialCursor: '0', eventRepository: source.repository, eventStream: source.stream });
  assert.equal(chunks.length, 1100); release();
});
await test('远程流不注册工作台/不发connected，撤销清理订阅', async () => {
  const source = sourceEvents(); let workbenchSubscriptions = 0; let revoke;
  const routes = createEventStreamRequestHandler({ eventRepository: source.repository, eventStream: source.stream, workbenchEvents: { subscribe() { workbenchSubscriptions++; return () => {}; }, nextSeq: () => 1 } });
  const req = request({ path: '/api/events?after=0&windowId=remote-window' }); const res = new Response();
  await routes.handle(req, res, { sessionId: 'global-coordinator', bind: close => { revoke = close; return () => {}; } });
  assert.equal(res.status, 200); assert.equal(workbenchSubscriptions, 0); assert.ok(!res.chunks.join('').includes('workbench.connected'));
  assert.equal(routes.activeConnectionCount(), 1); revoke(); assert.equal(routes.activeConnectionCount(), 0); assert.equal(source.listeners.size, 0);
});
await test('本机工作台订阅保持，断连释放', async () => {
  const source = sourceEvents(); let subscriptions = 0;
  const routes = createEventStreamRequestHandler({ eventRepository: source.repository, eventStream: source.stream, workbenchEvents: { subscribe() { subscriptions++; return () => subscriptions--; }, nextSeq: () => 1 } });
  const res = new Response(); await routes.handle(request({ path: '/api/events?after=1100' }), res);
  assert.equal(subscriptions, 1); assert.match(res.chunks.join(''), /workbench.connected/u); routes.disconnectAll(); assert.equal(subscriptions, 0);
});
await test('背压积压超限或关闭后不再写数据', () => {
  const req = request(); const res = new Response(); res.write = function (chunk) { this.chunks.push(chunk); return false; };
  let sink; let cleanups = 0;
  const connection = createSseConnection({ request: req, response: res, heartbeatMs: 10000, maxQueuedEvents: 2, maxQueuedBytes: 1000, onClose() {}, open(value) { sink = value; return () => cleanups++; } });
  connection.start(); sink.send('one'); sink.send('two'); sink.send('three');
  assert.equal(connection.isClosed(), true); assert.equal(cleanups, 1); const count = res.chunks.length; sink.send('after'); assert.equal(res.chunks.length, count);
});

const fixture = join(output, 'remote-assets-fixture');
await mkdir(join(fixture, 'assets'), { recursive: true }); await writeFile(join(fixture, 'index.html'), '<html>fixture</html>'); await writeFile(join(fixture, 'assets', 'app-123.js'), 'console.log("fixture")');
await symlink('app-123.js', join(fixture, 'assets', 'linked.js')).catch(() => undefined);
await test('公开页面/构建资源可用，拒绝源码/穿越/符号链接', async () => {
  const assets = createWebAssetsHandler(fixture);
  const home = new Response(); assert.equal(await assets(request({ path: '/' }), home), true); assert.equal(home.status, 200); assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/u);
  const script = new Response(); assert.equal(await assets(request({ path: '/assets/app-123.js' }), script), true); assert.match(script.headers['content-type'], /javascript/u);
  for (const path of ['/package.json', '/src/main.ts', '/assets/linked.js', '/assets/../package.json', '/assets/.secret.js', '/assets/app-123.js.map', '/workspace']) assert.equal(await assets(request({ path }), new Response()), false, path);
});
await rm(fixture, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const report = { environment: { node: process.version, platform: process.platform, architecture: process.arch, network: 'not used', childProcesses: 'not created' },
  contractFixture: 'SSE literals extracted from current contracts source; WindowId Check is a test double',
  results, passed: results.filter(value => value.passed).length, failed: results.filter(value => !value.passed).length,
  notVerified: ['npm build/typecheck', 'full HTTP router and shared schema integration', 'React/browser/mobile E2E', 'real model', 'real LAN/HTTPS reverse proxy', 'complete local workbench regression'] };
await writeFile(join(output, 'remote-native-validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, evidence: 'artifacts/remote-native-validation.json' }));
if (report.failed) process.exitCode = 1;
