import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { completedItems, terminal } from './fixtures/responses-stream.js';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { DefaultPiCoordinatorSessionFactory } from '../src/runtime/executors/pi-session-factory.js';

// 离线真实 SDK 检查：验证内存设置和 transcript，不代表真实模型请求已核验。
test('本轮 Pi 配置真实作用于同一 Agent，恢复与重开不改变持久模型或系统边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-turn-agent-sdk-'));
  const cwd = join(root, 'work'); const agentDir = join(root, 'agent'); const sessionDir = join(root, 'sessions');
  await mkdir(cwd); await mkdir(agentDir);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'offline-placeholder' } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
  const models = runtime.getModels('openai').filter(model => model.api === 'openai-responses');
  const plain = models.find(model => !model.reasoning)!;
  const reasoning = models.find(model => model.reasoning)!;
  const config: CoordinatorRuntimeConfig = { systemPrompt: '保留文件授权与工具边界。', authorizedContext: [], model: { provider: plain.provider, modelId: plain.id, source: 'base', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  let actual: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir, sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, modelsPath: null, createAgentSession: async options => { const result = await createAgentSession(options); actual = result.session; return result; } }) });
  try {
    const ready = await adapter.createSession({ assistantSessionId: 'work', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.equal(ready.ok, true);
    if (!ready.ok) return;
    const original = actual!.agent.state;
    const prompt = original.systemPrompt;
    const tools = actual!.getActiveToolNames();
    const count = SessionManager.open(ready.value.binding.runtimeSessionRef, sessionDir, cwd).getBranch().length;
    const preparation = await adapter.prepareTurnExecution('work', { provider: reasoning.provider, modelId: reasoning.id, thinkingLevel: 'high', source: 'base' }, '本轮先检查风险。');
    assert.equal(preparation.ok, true);
    if (!preparation.ok) return;
    preparation.value.activate();
    assert.equal(actual!.model?.id, reasoning.id);
    assert.equal(actual!.thinkingLevel, 'high');
    assert.equal(actual!.agent.state.systemPrompt, prompt, '本轮指令在请求时投影');
    assert.deepEqual(actual!.getActiveToolNames(), tools);
    assert.equal(SessionManager.open(ready.value.binding.runtimeSessionRef, sessionDir, cwd).getBranch().length, count);
    preparation.value.restore();
    preparation.value.restore();
    assert.equal(actual!.model?.id, plain.id);
    assert.equal(actual!.thinkingLevel, 'off');
    assert.equal(actual!.agent.state.systemPrompt, prompt);
    adapter.disposeSession('work');
    assert.equal((await adapter.continueSession({ binding: ready.value.binding, config, workingDirectory: { kind: 'session-temp', path: cwd } })).ok, true);
    assert.equal(actual!.model?.id, plain.id);
    assert.doesNotMatch(actual!.agent.state.systemPrompt, /本轮先检查风险/);
  } finally { adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('Pi 目录能力在本轮选模后生效，普通发送和两种追加均传递图片', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-image-'));
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions');
  await mkdir(cwd); await mkdir(agentDir);
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'sk-controlled-key' } }), { mode: 0o600 });
  const bodies: Array<{ model: string; input: unknown; instructions?: string }> = [];
  const firstRequest = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let catalogRequests = 0;
  const upstream = createServer(async (request, response) => {
    if (new URL(request.url!, 'http://localhost').pathname === '/api/models/providers/openai') {
      catalogRequests++;
      response.writeHead(200, { 'content-type': 'application/json', 'last-modified': 'Fri, 01 Jan 2100 00:00:00 GMT' });
      response.end(JSON.stringify([{ id: 'gpt-6.2-sol', provider: 'openai', name: 'GPT-6.2 Sol', api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1', input: ['text', 'image'], reasoning: true, contextWindow: 128000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (bodies.length === 1) { firstRequest.resolve(); await release.promise; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([...completedItems(), terminal()].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}`;
  const model = { provider: 'openai', modelId: 'controlled-text', protocol: 'openai-responses',
    endpoint: `${origin}/v1`, resolvedEndpoint: `${origin}/v1`, profileId: 'controlled-text', source: 'controlled', thinkingLevel: 'off' } as const;
  const config: CoordinatorRuntimeConfig = { systemPrompt: '基础系统边界。', model, authorizedContext: [],
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir,
    sessionFactory: new DefaultPiCoordinatorSessionFactory({ authPath, temporaryRoot: root,
      createModelRuntime: options => ModelRuntime.create({ ...options, catalogBaseUrl: origin }) }) });
  const images = await Promise.all(['red', 'green', 'blue'].map(async id => ({ id, mimeType: 'image/png',
    data: (await sharp({ create: { width: 2, height: 2, channels: 3, background: id } }).png().toBuffer()).toString('base64') })));
  try {
    const ready = await adapter.createSession({ assistantSessionId: 'work', config, workingDirectory: { kind: 'session-temp', path: cwd } });
    assert.ok(ready.ok, JSON.stringify(ready));
    assert.equal(adapter.supportsImageInput('work'), false);
    assert.equal((await adapter.prompt('work', 'reject', undefined, undefined, undefined, [images[0]!])).ok, false);
    assert.equal(bodies.length, 0);
    const turn = await adapter.prepareTurnExecution('work', { ...model, modelId: 'gpt-6.2-sol', profileId: 'controlled-vision', thinkingLevel: 'high' }, '仅本轮检查图片。');
    assert.ok(turn.ok, JSON.stringify(turn));
    turn.value.activate();
    assert.equal(adapter.supportsImageInput('work'), true);
    const running = adapter.prompt('work', 'first image', undefined, undefined, undefined, [images[0]!]);
    try {
      await Promise.race([firstRequest.promise, running.then(result => assert.fail(JSON.stringify(result)))]);
      assert.ok((await adapter.steer('work', 'steer image', undefined, undefined, [images[1]!])).ok);
      assert.ok((await adapter.followUp('work', 'follow-up image', undefined, undefined, [images[2]!])).ok);
    } finally { release.resolve(); }
    const result = await running;
    assert.ok(result.ok && result.value.status === 'completed', JSON.stringify(result));
    const turnRequests = bodies.slice();
    assert.equal(turnRequests.length, 3);
    for (const [index, body] of turnRequests.entries()) {
      assert.equal(body.model, 'gpt-6.2-sol');
      assert.ok(JSON.stringify(body).includes('仅本轮检查图片。'));
      const wire = JSON.stringify(body.input);
      assert.ok(wire.includes('input_image') && wire.includes(`data:image/png;base64,${images[index]!.data}`));
    }
    turn.value.restore();
    assert.equal(adapter.supportsImageInput('work'), false);
    assert.ok((await adapter.prompt('work', 'text after restore')).ok);
    assert.equal(bodies.at(-1)?.model, model.modelId);
    assert.ok(!JSON.stringify(bodies.at(-1)).includes('仅本轮检查图片。'));
    assert.equal(catalogRequests, 1);
  } finally {
    release.resolve();
    adapter.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
