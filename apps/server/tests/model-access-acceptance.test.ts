import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { format } from 'node:util';
import { MODEL_ACCESS_BODY_LIMIT_BYTES, type ModelProfileInput } from '@multivac/contracts';
import { createMultivacApplication, type MultivacApplicationOptions } from '../src/bootstrap/application.js';
import { PiModelAccessBackend } from '../src/runtime/executors/pi-model-access-backend.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { ModelAccessService } from '../src/application/model-access-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { FileModelSettingsStore } from '../src/storage/file-model-settings-store.js';
import { FileModelAccessStore } from '../src/storage/file-model-access-store.js';
import { admitAccessSnapshot } from '../../web/src/features/models/model-settings-view-state.js';

const profile: ModelProfileInput = { profileId: 'access', displayName: 'Access', provider: 'missing-auth', modelId: 'model',
  protocol: 'openai-completions', endpoint: 'http://127.0.0.1:11434/v1' };
async function bounded<T>(operation: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('test handshake timed out')), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}
async function harness(root: string, model: ModelProfileInput, options: MultivacApplicationOptions = {}) {
  await writeFile(join(root, 'model-settings.json'), JSON.stringify({ revision: 0, defaultProfileId: null, commands: [], profiles: [model] }));
  const app = createMultivacApplication({ MULTIVAC_DATA_DIR: root, MULTIVAC_FAKE_ASSISTANT: '1' }, options);
  try {
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  } catch (error) { app.close(); throw error; }
  const port = (app.server.address() as import('node:net').AddressInfo).port;
  return { app, port, close: async () => {
    try { await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve())); }
    finally { app.close(); }
  } };
}
async function raw(port: number, path: string, body?: string, contentType: string | null = 'application/json') {
  return new Promise<{ status: number; text: string; body: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST',
      headers: contentType === null ? {} : { 'content-type': contentType } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, text, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('error', reject); req.setTimeout(8000, () => req.destroy(new Error('test HTTP deadline'))); req.end(body);
  });
}
async function cmd(port: number, id: string) {
  const snapshot = (await raw(port, '/api/model-access')).body;
  return { commandId: id, profileId: 'access', revision: snapshot.revision, accessRevision: snapshot.accessRevision };
}
async function settled(port: number, id: string) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const response = await raw(port, '/api/model-access');
    const check = response.body.checks.find((entry: any) => entry.checkId === id);
    if (check && check.status !== 'checking') return { response, check };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('check did not settle');
}

test('HTTP Key 字符上限、12 KiB 字节边界、非法 JSON/Content-Type/读取中断均受控且未执行凭据命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-access-boundaries-'));
  const target = await harness(root, profile);
  try {
    const maximum = { ...await cmd(target.port, 'key-max'), apiKey: 'k'.repeat(8192) };
    assert.equal((await raw(target.port, '/api/model-access/api-key', JSON.stringify(maximum))).status, 200);
    const baseline = await cmd(target.port, 'key-too-long');
    const cases = [
      { id: 'key-too-long', body: JSON.stringify({ ...baseline, apiKey: 'k'.repeat(8193) }), type: 'application/json' },
      { id: 'invalid-json', body: `{"commandId":"invalid-json","apiKey":"partial-secret",`, type: 'application/json' },
      ...[null, 'text/plain', 'application/jsonish', 'application/json-patch+json'].map((type, index) => ({
        id: `content-type-${index}`, body: JSON.stringify({ ...baseline, commandId: `content-type-${index}`, apiKey: 'type-secret' }), type,
      })),
    ];
    const exact = JSON.stringify({ ...baseline, commandId: 'exact-body', apiKey: 'byte-boundary-key' });
    const padded = exact + ' '.repeat(MODEL_ACCESS_BODY_LIMIT_BYTES - Buffer.byteLength(exact));
    assert.equal(Buffer.byteLength(padded), 12 * 1024);
    const oversized = padded.replace('exact-body', 'over-limit') + ' ';
    assert.equal(Buffer.byteLength(oversized), MODEL_ACCESS_BODY_LIMIT_BYTES + 1);
    cases.push({ id: 'over-limit', body: oversized, type: 'application/json' });
    const unicode = JSON.stringify({ ...baseline, commandId: 'utf8-over-body', apiKey: '界'.repeat(5000) });
    assert.ok(unicode.length < MODEL_ACCESS_BODY_LIMIT_BYTES && Buffer.byteLength(unicode) > MODEL_ACCESS_BODY_LIMIT_BYTES);
    cases.push({ id: 'utf8-over-body', body: unicode, type: 'application/json' });
    for (const entry of cases) {
      const before = (await raw(target.port, '/api/model-access')).body.accessRevision;
      const result = await raw(target.port, '/api/model-access/api-key', entry.body, entry.type);
      assert.equal(result.status, 400, entry.id);
      assert.deepEqual(result.body, { error: { code: 'INVALID_REQUEST' } });
      assert.equal((await raw(target.port, '/api/model-access')).body.accessRevision, before);
      assert.equal((await raw(target.port, `/api/model-access/commands/${entry.id}`)).status, 404);
    }
    assert.equal((await raw(target.port, '/api/model-access/api-key', padded, 'Application/JSON; charset=utf-8')).status, 200);
    const afterExact = (await raw(target.port, '/api/model-access')).body.accessRevision;
    let received!: () => void; let aborted!: () => void;
    const entry = new Promise<void>((resolve) => { received = resolve; });
    const interrupted = new Promise<void>((resolve) => { aborted = resolve; });
    target.app.server.once('request', (incoming) => { incoming.once('aborted', aborted); received(); });
    const outgoing = request({ hostname: '127.0.0.1', port: target.port, path: '/api/model-access/api-key', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '4096' } });
    outgoing.on('error', () => {});
    outgoing.write('{"commandId":"interrupted","apiKey":"interrupt-secret');
    await bounded(entry); outgoing.destroy(); await bounded(interrupted);
    const recovered = await raw(target.port, '/api/model-access');
    assert.equal(recovered.status, 200); assert.equal(recovered.body.accessRevision, afterExact);
    assert.equal((await raw(target.port, '/api/model-access/commands/interrupted')).status, 404);
    const metadata = await readFile(target.app.paths.modelAccessPath, 'utf8');
    for (const secret of ['partial-secret', 'type-secret', 'interrupt-secret', maximum.apiKey]) assert.equal(metadata.includes(secret), false);
  } finally { await target.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实 Pi 本地 HTTP：service 自主 deadline 关闭流并安全 timeout；恶意错误不泄漏至响应/日志/SSE/存储', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-access-security-'));
  const key = 'security-sentinel-key';
  const authorization = `Authorization: Bearer ${key}`;
  const sensitiveUrl = `https://user:${key}@upstream.invalid/private?api_key=${key}#credential`;
  const logs: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, level, (...args: unknown[]) => logs.push(format(...args)));
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    t.mock.method(stream, 'write', (...args: any[]) => { logs.push(String(args[0])); return (original as any)(...args); });
  }
  console.info('log-capture-probe'); process.stderr.write('stderr-capture-probe\n');
  let hang = false; let requests = 0; let streamClosed = false;
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const upstream = createServer((req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.equal(req.url, '/v1/chat/completions');
    if (hang) {
      res.once('close', () => { streamClosed = true; });
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); arrived();
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `${key} ${authorization} ${sensitiveUrl}` } }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}/v1`;
  const authPath = join(root, 'auth.json');
  const nativeProfile = { ...profile, provider: 'acceptance-provider', endpoint };
  const deadlineMs = 1500;
  let target: Awaited<ReturnType<typeof harness>> | undefined;
  let sse: ReturnType<typeof request> | undefined;
  try {
    target = await harness(root, nativeProfile, {
      modelAccessBackend: new PiModelAccessBackend({ authPath }), modelAccessTimeoutMs: deadlineMs,
      modelSettingsCatalogFactory: new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }),
    });
    let sseText = ''; let sseReady!: () => void; let terminalEvent!: () => void;
    const ready = new Promise<void>((resolve) => { sseReady = resolve; });
    const terminal = new Promise<void>((resolve) => { terminalEvent = resolve; });
    sse = request({ hostname: '127.0.0.1', port: target.port, path: '/api/assistant/events?after=0' }, (res) => {
      assert.equal(res.statusCode, 200); sseReady();
      res.on('data', (chunk) => { sseText += String(chunk); if (sseText.includes('assistant.run.succeeded')) terminalEvent(); });
    });
    sse.on('error', () => {}); sse.end();
    await bounded(ready);
    const responses: string[] = [];
    const configured = await raw(target.port, '/api/model-access/api-key', JSON.stringify({ ...await cmd(target.port, 'configure'), apiKey: key }));
    assert.equal(configured.body.state, 'committed'); responses.push(configured.text);
    const prompt = await raw(target.port, '/api/assistant/turns', JSON.stringify({ commandId: 'security-event-probe',
      assistantSessionId: 'global-coordinator', text: '安全验收事件探针', contextRefs: [] }));
    assert.equal(prompt.status, 200); responses.push(prompt.text);
    const failedStart = await raw(target.port, '/api/model-access/check', JSON.stringify(await cmd(target.port, 'malicious-upstream')));
    assert.equal(failedStart.status, 202); responses.push(failedStart.text);
    const failed = await settled(target.port, 'malicious-upstream');
    assert.equal(failed.check.status, 'failed'); assert.equal(failed.check.errorCode, 'CHECK_FAILED'); responses.push(failed.response.text);
    hang = true;
    const began = Date.now();
    const timeoutStart = await raw(target.port, '/api/model-access/check', JSON.stringify(await cmd(target.port, 'autonomous-timeout')));
    assert.equal(timeoutStart.status, 202); responses.push(timeoutStart.text);
    await bounded(arrival);
    const timed = await settled(target.port, 'autonomous-timeout');
    assert.equal(timed.check.status, 'timed-out'); assert.equal(timed.check.errorCode, 'CHECK_TIMEOUT');
    assert.ok(Date.now() - began >= deadlineMs - 100 && Date.now() - began < 8000);
    responses.push(timed.response.text);
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 2000;
      const check = () => streamClosed ? resolve() : Date.now() > until ? reject(new Error('upstream did not close')) : setTimeout(check, 10);
      check();
    });
    assert.equal(requests, 2);
    await bounded(terminal);
    assert.ok(sseText.includes('assistant.run.processing') && sseText.includes('assistant.run.succeeded'));
    assert.ok(logs.some((text) => text.includes('log-capture-probe')) && logs.some((text) => text.includes('stderr-capture-probe')));
    for (const path of [target.app.paths.databasePath, target.app.paths.modelSettingsPath, target.app.paths.modelAccessPath]) {
      responses.push((await readFile(path)).toString('utf8'));
    }
    for (const value of [key, authorization, sensitiveUrl, 'api_key=', 'Bearer ', 'Authorization']) {
      assert.equal([...responses, sseText, ...logs].some((text) => text.includes(value)), false, `public sink leaked ${value}`);
    }
  } finally {
    sse?.destroy();
    try { await target?.close(); }
    finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      t.mock.restoreAll(); await rm(root, { recursive: true, force: true });
    }
  }
});

test('真实 Pi ambient OPENAI_API_KEY 消失：同一 service 的认证/可用状态更新，不误称已保存 Key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-access-ambient-'));
  const previous = process.env.OPENAI_API_KEY;
  const official: ModelProfileInput = { ...profile, provider: 'openai', modelId: 'gpt-4.1-mini', protocol: 'openai-responses', endpoint: null };
  const modelPath = join(root, 'models.json'); const authPath = join(root, 'auth.json');
  await writeFile(modelPath, JSON.stringify({ revision: 0, defaultProfileId: null, commands: [], profiles: [official] }));
  process.env.OPENAI_API_KEY = 'ambient-test-only';
  const settings = new ModelSettingsService(new FileModelSettingsStore(modelPath), new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }));
  const backend = new PiModelAccessBackend({ authPath });
  const service = new ModelAccessService({ settings, backend, store: new FileModelAccessStore(join(root, 'access.json')) });
  try {
    await settings.initialize();
    const before = await service.getSnapshot();
    assert.equal(before.credentials[0]?.storedApiKey, false);
    assert.equal(before.availability[0]?.authenticated, true); assert.equal(before.availability[0]?.available, true);
    const version = await backend.credentialVersion();
    delete process.env.OPENAI_API_KEY;
    const after = await service.getSnapshot();
    assert.equal(after.credentials[0]?.storedApiKey, false);
    assert.equal(after.availability[0]?.authenticated, false); assert.equal(after.availability[0]?.available, false);
    assert.equal(await backend.credentialVersion(), version);
    assert.ok(after.accessRevision > before.accessRevision);
    assert.equal(admitAccessSnapshot(after, before), after);
    assert.equal(JSON.stringify(after).includes('ambient-test-only'), false);
  } finally {
    try { await service.close(); }
    finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
      await rm(root, { recursive: true, force: true });
    }
  }
});
