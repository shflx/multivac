import { loadSource, sourceJavaScript } from './source-loader.mjs';
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const assert = process.getBuiltinModule('node:assert/strict');
const crypto = process.getBuiltinModule('node:crypto');
const root = fs.mkdtempSync(path.join(process.cwd(), '.browser-isolation-'));
const runtime = loadSource('apps/server/src/runtime-config.ts', { ...path, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, homedir: () => root, createHash: crypto.createHash }, ['resolveRuntimeConfig', 'resolvePort']);
const { RemoteAccess } = loadSource('apps/server/src/adapters/http/remote-access.ts', { createHash: crypto.createHash, randomBytes: crypto.randomBytes, timingSafeEqual: crypto.timingSafeEqual }, ['RemoteAccess']);
const tokenFs = Object.fromEntries(['closeSync', 'constants', 'fchmodSync', 'fstatSync', 'linkSync', 'mkdirSync', 'openSync', 'readFileSync', 'unlinkSync', 'writeFileSync'].map(name => [name, fs[name]]));
const { loadOrCreateRemoteToken } = loadSource('apps/server/src/storage/remote-access-token.ts', { ...path, ...tokenFs, randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID }, ['loadOrCreateRemoteToken']);
const production = runtime.resolveRuntimeConfig({});
const development = runtime.resolveRuntimeConfig({ MULTIVAC_MODE: 'development' });
const prodToken = loadOrCreateRemoteToken(production.dataDir);
const devToken = loadOrCreateRemoteToken(development.dataDir);
assert.notEqual(prodToken, devToken);
assert.equal(loadOrCreateRemoteToken(production.dataDir), prodToken);
assert.equal(loadOrCreateRemoteToken(development.dataDir), devToken);
const base = { enabled: true, host: '127.0.0.1', origin: '' };
const prod = new RemoteAccess({ ...base, token: prodToken }, Date.now, production.cookieName);
let dev = new RemoteAccess({ ...base, token: devToken }, Date.now, development.cookieName);
// 同主机Cookie jar：忽略端口，所有Cookie同时随两个实例请求发送。
const jar = new Map();
function request(config, method = 'GET', endpoint = '/api/access', body) {
  const host = `device.example:${config.port}`;
  return { method, url: endpoint, headers: { host, origin: `http://${host}`, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), 'content-type': 'application/json' }, socket: { remoteAddress: '192.0.2.10' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
}
async function send(auth, config, endpoint, token) {
  const req = request(config, 'POST', endpoint, token === undefined ? undefined : { token });
  const response = { headers: {}, status: 0, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
  const access = auth.identify(req); assert.ok(access);
  await auth.handle(req, response, access);
  const cookie = response.headers['set-cookie'];
  if (cookie) {
    const [name, value] = cookie.split(';')[0].split('=');
    if (cookie.includes('Max-Age=0')) jar.delete(name); else jar.set(name, value);
    assert.ok(cookie.includes('HttpOnly')); assert.ok(cookie.includes('SameSite=Strict')); assert.ok(cookie.includes('Path=/'));
  }
  return response;
}
const authenticated = (auth, config) => auth.identify(request(config))?.authenticated;
try {
  assert.equal(authenticated(prod, production), false); assert.equal(authenticated(dev, development), false);
  assert.equal((await send(dev, development, '/api/access/login', prodToken)).status, 401);
  assert.equal((await send(prod, production, '/api/access/login', prodToken)).status, 200);
  const prodCookie = jar.get(production.cookieName);
  assert.equal((await send(dev, development, '/api/access/login', devToken)).status, 200);
  assert.equal(jar.size, 2); assert.equal(jar.get(production.cookieName), prodCookie);
  assert.equal(authenticated(prod, production), true); assert.equal(authenticated(dev, development), true);
  console.log('PASS 独立token持久复用、未登录拒绝、错误token拒绝、同主机Cookie jar双登录与刷新');
  assert.equal((await send(dev, development, '/api/access/logout')).status, 200);
  assert.equal(authenticated(dev, development), false); assert.equal(authenticated(prod, production), true);
  assert.equal(jar.get(production.cookieName), prodCookie);
  console.log('PASS 开发退出仅清理自己的Cookie，生产继续登录');
  await send(dev, development, '/api/access/login', devToken);
  let prodClosed = 0; let devClosed = 0;
  prod.bind(prod.identify(request(production)), () => prodClosed++);
  dev.bind(dev.identify(request(development)), () => devClosed++);
  dev.configure({ ...base, token: 'rotated-development-token-fixture-32bytes' });
  assert.equal(devClosed, 1); assert.equal(prodClosed, 0);
  assert.equal(authenticated(dev, development), false); assert.equal(authenticated(prod, production), true);
  await send(dev, development, '/api/access/login', 'rotated-development-token-fixture-32bytes');
  dev.close(); dev = new RemoteAccess({ ...base, token: devToken }, Date.now, development.cookieName);
  assert.equal(authenticated(dev, development), false); assert.equal(authenticated(prod, production), true);
  console.log('PASS 开发token轮换与重建撤销自己的登录/连接，生产登录及连接保留');
  const local = { method: 'GET', headers: { host: '127.0.0.1:4317', cookie: `${development.cookieName}=bad` }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(prod.identify(local)?.kind, 'local');
  console.log('PASS 其他实例Cookie不干扰本机身份，默认生产Cookie名称兼容');
  const viteSource = sourceJavaScript('apps/web/vite.config.ts').replace('export default defineConfig', 'return defineConfig');
  const vite = (environment, command = 'serve') => new Function('process', 'defineConfig', 'react', 'resolveRuntimeConfig', 'resolvePort', viteSource)({ env: environment }, factory => factory({ command }), () => [], runtime.resolveRuntimeConfig, runtime.resolvePort);
  assert.equal(vite({}).server.proxy['/api'].target, 'http://127.0.0.1:4318');
  assert.equal(vite({ MULTIVAC_PORT: '4490' }).server.proxy['/api'].target, 'http://127.0.0.1:4490');
  assert.equal(vite({ MULTIVAC_E2E_API_PORT: '4491' }).server.proxy['/api'].target, 'http://127.0.0.1:4491');
  assert.throws(() => vite({ MULTIVAC_E2E_API_PORT: '4491', MULTIVAC_PORT: '4492' }), /冲突/u);
  assert.equal(vite({}).server.proxy['/api'].changeOrigin, false);
  assert.equal(vite({}).server.proxy['/api'].ws, true); assert.equal(vite({}).server.strictPort, true);
  assert.equal(vite({ MULTIVAC_MODE: 'production' }, 'build').server, undefined);
  assert.throws(() => vite({ MULTIVAC_MODE: 'production' }), /冲突/u);
  console.log('PASS Vite默认/显式/E2E端口及冲突，保留Host、升级代理和严格监听端口；生产构建不解析开发实例');
  console.log('限制：执行真实鉴权和配置源码，HTTP对象与Cookie jar为测试替身；没有启动浏览器、Vite或双应用服务。');
} finally { prod.close(); dev.close(); fs.rmSync(root, { recursive: true, force: true }); }
