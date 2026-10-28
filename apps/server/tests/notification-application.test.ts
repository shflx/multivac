import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

/** 完整服务装配及远程门禁，使用独立临时实例和Fake执行器，不绑定微信。 */
test('应用启动/重启保留单微信关闭配置；真实HTTP远程管理拒绝，本机可读无秘密', async () => {
  const base = resolve('.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'notification-application-'));
  const token = 'notification-fixture-token-more-than-32-bytes';
  const environment = { ...testApplicationEnvironment(root), MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_TOKEN: token, MULTIVAC_REMOTE_ORIGIN: 'https://remote.example' };
  let app = createMultivacApplication(environment);
  async function start() {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return (app.server.address() as { port: number }).port;
  }
  async function stop() {
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close();
  }
  function http(port: number, path: string, headers: Record<string, string> = {}, body?: unknown) {
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  try {
    let port = await start();
    const local = await http(port, '/api/notification-channels'); assert.equal(local.status, 200);
    assert.equal(local.body.items.length, 1); assert.equal(local.body.items[0].enabled, false); assert.equal(local.body.items[0].readiness, 'waiting');
    assert.doesNotMatch(JSON.stringify(local.body), /context_token|bot_token|secretRef/);
    assert.equal(existsSync(join(root, 'data/notification-secrets/wechat')), false);
    const remote = { host: 'remote.example', origin: 'https://remote.example' };
    const login = await http(port, '/api/access/login', remote, { token });
    assert.equal(login.status, 200); const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    for (const path of ['/api/notification-channels', '/api/notification-channels/wechat-self/wechat', '/api/notification-channels/wechat-self/wechat/qr']) {
      assert.equal((await http(port, path, { ...remote, cookie })).status, 403);
    }
    assert.equal((await http(port, '/api/notification-channels/wechat-self/test', { ...remote, cookie }, { commandId: 'remote-test', version: 1 })).status, 403);
    await stop(); app = createMultivacApplication(environment); port = await start();
    assert.deepEqual((await http(port, '/api/notification-channels')).body, local.body);
    assert.equal((await http(port, '/api/inbox')).body.pendingCount, 0);
  } finally { await stop(); await rm(root, { recursive: true, force: true }); }
});
