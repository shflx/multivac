import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function http(port: number, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let text = ''; res.on('data', chunk => { text += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function editableProfile(profile: Record<string, unknown>, displayName: string) {
  const { capabilities: _capabilities, ...input } = profile;
  return { ...input, displayName };
}

test('双应用和真实Vite代理：独立会话、模型设置、工作文件、登录及开发单独重建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-dual-instances-'));
  const environments = ['production', 'development'].map(mode => ({
    ...testApplicationEnvironment(join(root, mode)), MULTIVAC_MODE: mode,
    MULTIVAC_REMOTE_ENABLED: '1',
  }));
  const prod = createMultivacApplication(environments[0]!);
  let dev: ReturnType<typeof createMultivacApplication> | undefined;
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let proxy: Server | undefined;
  const jar = new Map<string, string>();
  async function remote(port: number, path = '/api/access', token?: string) {
    const host = `instances.example:${port}`;
    const result = await http(port, path, path === '/api/access' ? 'GET' : 'POST', token === undefined ? undefined : { token }, {
      host, origin: `http://${host}`, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    });
    const cookies = result.headers['set-cookie'];
    for (const cookie of typeof cookies === 'string' ? [cookies] : cookies ?? []) {
      const [name, value] = cookie.split(';')[0]!.split('=');
      if (cookie.includes('Max-Age=0')) jar.delete(name!); else jar.set(name!, value!);
    }
    return result;
  }
  try {
    await prod.ready;
    const prodPort = await listen(prod.server);
    const initial = (await http(prodPort, '/api/assistant/page-state')).body;
    assert.equal((await http(prodPort, '/api/assistant/page-state', 'PUT', { ...initial, draft: 'production-history' })).status, 200);
    const prodSession = await http(prodPort, '/api/sessions', 'POST', { sessionId: 'same-id', title: '生产样本' });
    assert.equal(prodSession.status, 201);
    const prodDirectory = prodSession.body.session.workingDirectory.path as string;
    await writeFile(join(prodDirectory, 'marker.txt'), 'production-file');
    const prodSettings = (await http(prodPort, '/api/model-settings')).body;
    assert.equal((await http(prodPort, '/api/model-settings/profiles', 'POST', {
      commandId: 'prod-profile-save', revision: prodSettings.revision,
      profile: editableProfile(prodSettings.profiles[0], '生产已保存配置'),
    })).status, 200);
    const originalSettings = await readFile(prod.paths.modelSettingsPath, 'utf8');

    dev = createMultivacApplication(environments[1]!); await dev.ready;
    const devPort = await listen(dev.server);
    assert.notEqual(prod.paths.databasePath, dev.paths.databasePath);
    assert.notEqual(prod.remoteAccess.settings().token, dev.remoteAccess.settings().token);
    assert.equal((await http(devPort, '/api/assistant/page-state')).body.draft, '');
    const devSession = await http(devPort, '/api/sessions', 'POST', { sessionId: 'same-id', title: '开发样本' });
    assert.equal(devSession.status, 201);
    assert.notEqual(devSession.body.session.workingDirectory.path, prodDirectory);
    await writeFile(join(devSession.body.session.workingDirectory.path, 'marker.txt'), 'development-file');
    const devState = (await http(devPort, '/api/assistant/page-state')).body;
    await http(devPort, '/api/assistant/page-state', 'PUT', { ...devState, draft: 'development-only' });
    const settings = (await http(devPort, '/api/model-settings')).body;
    assert.equal((await http(devPort, '/api/model-settings/profiles', 'POST', {
      commandId: 'dev-profile-change', revision: settings.revision,
      profile: editableProfile(settings.profiles[0], '只修改开发设置'),
    })).status, 200);
    assert.equal(await readFile(prod.paths.modelSettingsPath, 'utf8'), originalSettings);
    assert.equal((await http(prodPort, '/api/assistant/page-state')).body.draft, 'production-history');
    assert.equal((await http(prodPort, '/api/sessions')).body.sessions[0].title, '生产样本');

    // 从真实Vite配置加载代理；加载期间临时提供测试实例环境，测试不并发执行。
    const keys = ['MULTIVAC_MODE', 'MULTIVAC_DATA_DIR', 'MULTIVAC_WORK_ROOT', 'MULTIVAC_PORT', 'MULTIVAC_E2E_API_PORT'];
    const previous = new Map(keys.map(key => [key, process.env[key]]));
    let loaded: Awaited<ReturnType<typeof loadConfigFromFile>> = null;
    try {
      const viteEnvironment: NodeJS.ProcessEnv = { ...environments[1], MULTIVAC_PORT: String(devPort) };
      for (const key of keys) {
        if (viteEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = viteEnvironment[key];
      }
      loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, resolve('apps/web/vite.config.ts'));
    } finally {
      // 仅恢复本测试显式更改的环境，其他测试环境不动。
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    assert.ok(loaded);
    vite = await createViteServer({ ...loaded.config, configFile: false, root: resolve('apps/web'),
      server: { ...loaded.config.server, middlewareMode: true, hmr: false },
    });
    proxy = createServer(vite.middlewares); const proxyPort = await listen(proxy);
    assert.equal((await http(proxyPort, '/api/assistant/page-state')).body.draft, 'development-only');
    assert.equal((await remote(prodPort, '/api/access/login', prod.remoteAccess.settings().token)).status, 200);
    assert.equal((await remote(devPort, '/api/access/login', dev.remoteAccess.settings().token)).status, 200);
    assert.equal(jar.size, 2);
    await remote(devPort, '/api/access/logout');
    assert.equal((await remote(prodPort)).body.authenticated, true);

    await closeServer(proxy); proxy = undefined; await vite.close(); vite = undefined;
    await closeServer(dev.server); await dev.close(); dev = undefined;
    dev = createMultivacApplication(environments[1]!); await dev.ready;
    const restartedPort = await listen(dev.server);
    assert.equal((await http(restartedPort, '/api/assistant/page-state')).body.draft, 'development-only');
    assert.equal((await http(prodPort, '/api/assistant/page-state')).body.draft, 'production-history');
    assert.equal((await remote(prodPort)).body.authenticated, true);
    assert.equal(await readFile(join(prodDirectory, 'marker.txt'), 'utf8'), 'production-file');
    assert.equal(await readFile(prod.paths.modelSettingsPath, 'utf8'), originalSettings);
  } finally {
    if (proxy) await closeServer(proxy); if (vite) await vite.close();
    if (dev) { await closeServer(dev.server); await dev.close(); }
    await closeServer(prod.server); await prod.close();
    await rm(root, { recursive: true, force: true });
  }
});
