import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAccess, accessError } from '../src/adapters/http/remote-access.js';
import { resolveRuntimeConfig } from '../src/runtime-config.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}

test('两个端口共享同一主机Cookie jar时，登录退出和轮换仍按实例隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-cookie-instances-'));
  const production = resolveRuntimeConfig({}, undefined, root);
  const development = resolveRuntimeConfig({ MULTIVAC_MODE: 'development' }, undefined, root);
  const base = { enabled: true, origin: '', host: '127.0.0.1' };
  const prod = new RemoteAccess({ ...base, token: 'p'.repeat(32) }, Date.now, production.cookieName);
  const dev = new RemoteAccess({ ...base, token: 'd'.repeat(32) }, Date.now, development.cookieName);
  const servers = [prod, dev].map(auth => createServer((req, res) => {
    const access = auth.identify(req);
    if (!access) { accessError(res, 403, 'ACCESS_DENIED', '拒绝访问'); return; }
    void auth.handle(req, res, access);
  }));
  const jar = new Map<string, string>();
  async function http(port: number, path: string, token?: string) {
    const host = `device.example:${port}`;
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: path === '/api/access' ? 'GET' : 'POST', headers: {
        host, origin: `http://${host}`, 'content-type': 'application/json',
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
      } }, res => {
        for (const cookie of res.headers['set-cookie'] ?? []) {
          assert.match(cookie, /HttpOnly/u); assert.match(cookie, /SameSite=Strict/u);
          const [name, value] = cookie.split(';')[0]!.split('=');
          if (cookie.includes('Max-Age=0')) jar.delete(name!); else jar.set(name!, value!);
        }
        let body = ''; res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) as Record<string, unknown> }));
      });
      req.on('error', reject); req.end(token === undefined ? undefined : JSON.stringify({ token }));
    });
  }
  try {
    const [prodPort, devPort] = await Promise.all(servers.map(listen));
    assert.equal((await http(devPort!, '/api/access/login', 'p'.repeat(32))).status, 401);
    assert.equal((await http(prodPort!, '/api/access/login', 'p'.repeat(32))).status, 200);
    const original = jar.get(production.cookieName);
    assert.equal((await http(devPort!, '/api/access/login', 'd'.repeat(32))).status, 200);
    assert.equal(jar.size, 2);
    assert.equal((await http(prodPort!, '/api/access')).body.authenticated, true);
    assert.equal((await http(devPort!, '/api/access')).body.authenticated, true);
    await http(devPort!, '/api/access/logout');
    assert.equal((await http(devPort!, '/api/access')).body.authenticated, false);
    assert.equal((await http(prodPort!, '/api/access')).body.authenticated, true);
    assert.equal(jar.get(production.cookieName), original);
    await http(devPort!, '/api/access/login', 'd'.repeat(32));
    dev.configure({ ...base, token: 'r'.repeat(32) });
    assert.equal((await http(devPort!, '/api/access')).body.authenticated, false);
    assert.equal((await http(prodPort!, '/api/access')).body.authenticated, true);
  } finally {
    prod.close(); dev.close();
    await Promise.all(servers.map(async server => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }));
    await rm(root, { recursive: true, force: true });
  }
});
