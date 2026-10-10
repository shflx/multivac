import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ExecutionDiagnostics } from '../src/application/execution-diagnostics.js';
import { observedFetch, observedModelRuntime } from '../src/runtime/executors/observed-model-runtime.js';

async function fixture(options: ConstructorParameters<typeof ExecutionDiagnostics>[2] = { heartbeatMs: 0 }) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-diagnostics-'));
  const diagnostics = new ExecutionDiagnostics(root, sessionId => ({ sessionId, executionId: 'execution', taskId: 'task', runId: 'run', kind: 'task' }), options);
  return { root, diagnostics,
    async entries() { return (await readFile(diagnostics.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); },
    async close() { diagnostics.close(); await rm(root, { recursive: true, force: true }); } };
}

test('心跳区分墙钟跳变与单调时间停顿，活动请求保留各阶段计数', async () => {
  let wall = Date.now(), mono = 0;
  const f = await fixture({ heartbeatMs: 15000, clock: { wall: () => wall, monotonic: () => mono } });
  try {
    f.diagnostics.agentEvent('session', { type: 'agent_start' });
    const request = f.diagnostics.beginRequest('session', { provider: 'openai', id: 'model', api: 'openai-responses' }, true);
    wall += 15000; mono += 15000; f.diagnostics.sample();
    wall += 5 * 3600000; mono += 15000; f.diagnostics.sample();
    wall += 120000; mono += 120000; f.diagnostics.sample();
    const entries = await f.entries();
    const gaps = entries.filter(e => e.event === 'service.clock_gap');
    assert.equal(gaps.length, 2);
    assert.equal(gaps[0].clockDifferenceMs, 5 * 3600000 - 15000);
    assert.equal(gaps[1].clockDifferenceMs, 0); assert.equal(gaps[1].scheduledDelayMs, 105000);
    const progress = entries.filter(e => e.event === 'model.request.progress');
    assert.equal(progress.length, 3); assert.equal(progress[2].bodyBytes, 0); assert.equal(progress[2].modelEvents, 0);
    assert.equal(progress[2].executionId, 'execution'); assert.equal(progress[2].runId, 'run');
    assert.equal(progress[2].wallElapsedMs - progress[2].monoElapsedMs, 5 * 3600000 - 15000);
    request.finish({ stopReason: 'stop' }); f.diagnostics.agentEvent('session', { type: 'agent_end' });
    f.diagnostics.sample();
    assert.equal((await f.entries()).filter(e => e.event === 'service.heartbeat').at(-1).activeRequests, 0);
  } finally { await f.close(); }
});

test('流按需读取且原样交付，停滞可观测，取消保留原原因；日志不记录正文和凭据', async () => {
  const f = await fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>, cancelled: unknown;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel(reason) { cancelled = reason; } }, { highWaterMark: 0 });
  const upstream = new Response(body, { headers: { 'x-request-id': 'req-safe-123', 'authorization': 'Bearer response-secret', 'set-cookie': 'private-cookie' } });
  Object.defineProperty(upstream, 'url', { value: 'https://model.example/v1/responses' });
  const signal = new AbortController().signal;
  const init = { signal, headers: { authorization: 'Bearer request-secret' }, body: 'private-prompt', method: 'POST' };
  const request = f.diagnostics.beginRequest('session', { api: 'openai-responses' }, true);
  const response = await observedFetch(async (input, options) => {
    assert.equal(input, 'https://user:password@model.example/v1/responses?api_key=url-secret'); assert.equal(options, init); return upstream;
  }, request)('https://user:password@model.example/v1/responses?api_key=url-secret', init);
  try {
    assert.equal(response.url, upstream.url); assert.equal(body.locked, false); assert.equal(response.body, response.body);
    const reader = response.body!.getReader();
    const pending = reader.read();
    f.diagnostics.sample();
    assert.equal((await f.entries()).filter(e => e.event === 'model.request.progress').at(-1).bodyBytes, 0);
    const bytes = new TextEncoder().encode('data: private-model-output\n\n'); controller.enqueue(bytes);
    assert.deepEqual((await pending).value, bytes);
    request.event({ type: 'toolcall_delta', delta: 'private-tool-arguments' }); f.diagnostics.sample();
    const progress = (await f.entries()).filter(e => e.event === 'model.request.progress').at(-1);
    assert.equal(progress.bodyBytes, bytes.length); assert.equal(progress.toolArgumentChars, 'private-tool-arguments'.length);
    const reason = { stopped: true }; await reader.cancel(reason); reader.releaseLock(); assert.equal(cancelled, reason);
    request.finish({ stopReason: 'aborted' });
    const log = await readFile(f.diagnostics.path, 'utf8');
    for (const secret of ['response-secret', 'private-cookie', 'request-secret', 'private-prompt', 'url-secret', 'password', 'private-model-output', 'private-tool-arguments']) assert.ok(!log.includes(secret), secret);
    assert.ok(log.includes('req-safe-123')); assert.ok(log.includes('model.example'));
  } finally { await f.close(); }
});

test('流错误保持同一个异常对象，JSON 与 clone 语义保持，错误日志只提取分类', async () => {
  const f = await fixture();
  try {
    const request = f.diagnostics.beginRequest('session', {}, true);
    const failure = Object.assign(new Error('Connection error authorization=private-key'), { code: 'ECONNRESET' });
    const response = await observedFetch(async () => new Response(new ReadableStream({ start(controller) { controller.error(failure); } })), request)('https://model.example');
    await assert.rejects(response.body!.getReader().read(), error => error === failure);
    request.finish(undefined, failure);
    const jsonResponse = await observedFetch(async () => new Response('{"ok":true}'), f.diagnostics.beginRequest('session', {}, true))('https://model.example');
    assert.deepEqual(await jsonResponse.clone().json(), { ok: true }); assert.deepEqual(await jsonResponse.json(), { ok: true });
    assert.equal(jsonResponse.bodyUsed, true);
    const log = await readFile(f.diagnostics.path, 'utf8');
    assert.ok(log.includes('ECONNRESET')); assert.ok(!log.includes('private-key'));
  } finally { await f.close(); }
});

test('日志有固定容量和私有权限，关闭后不再写；写入失败不向执行传播', async () => {
  const f = await fixture({ heartbeatMs: 0, maxBytes: 2048 });
  try {
    for (let i = 0; i < 80; i++) f.diagnostics.record('test.event', { count: i });
    assert.deepEqual((await readdir(f.root)).sort(), ['execution.jsonl', 'execution.jsonl.1']);
    for (const name of await readdir(f.root)) {
      const info = await stat(join(f.root, name)); assert.ok(info.size <= 2048); assert.equal(info.mode & 0o777, 0o600);
      for (const line of (await readFile(join(f.root, name), 'utf8')).trim().split('\n')) JSON.parse(line);
    }
    f.diagnostics.close(); const before = await readFile(f.diagnostics.path, 'utf8');
    f.diagnostics.record('after.close'); f.diagnostics.sample(); assert.equal(await readFile(f.diagnostics.path, 'utf8'), before);
    const invalid = join(f.root, 'not-a-directory'); await writeFile(invalid, 'file');
    const broken = new ExecutionDiagnostics(invalid, sessionId => ({ sessionId }), { heartbeatMs: 0 });
    assert.doesNotThrow(() => broken.record('test')); assert.doesNotThrow(() => broken.close());
  } finally { await f.close(); }
});

test('SDK 代理保留 payload 回调、原参数和动态选模，不支持 fetch 的协议不注入传输', async () => {
  const f = await fixture(); const calls: unknown[][] = [];
  let current = { completeSimple: async (...args: unknown[]) => {
    calls.push(args); const options = args[2] as { onPayload: (...args: unknown[]) => Promise<unknown> };
    assert.equal(await options.onPayload({ private: 'payload' }, args[0]), 'unchanged-replacement');
    return { stopReason: 'stop', usage: { input: 1, output: 2, totalTokens: 3 } };
  }, getModel: () => 'first' } as unknown as ModelRuntime;
  try {
    const runtime = observedModelRuntime(() => current, 'session', f.diagnostics);
    const signal = new AbortController().signal, context = { messages: [] };
    const onResponse = () => {}; const options = { signal, onPayload: () => 'unchanged-replacement', onResponse };
    await runtime.completeSimple({ api: 'openai-responses', id: 'model' } as never, context, options as never);
    assert.equal(calls[0]![1], context);
    const passed = calls[0]![2] as Record<string, unknown>;
    assert.equal(passed.signal, signal); assert.equal(passed.onResponse, onResponse); assert.equal(typeof passed.fetch, 'function');
    await runtime.completeSimple({ api: 'unsupported-api' } as never, context, options as never);
    assert.ok(!('fetch' in (calls[1]![2] as object)));
    current = { getModel: () => 'second' } as unknown as ModelRuntime;
    assert.equal(runtime.getModel('provider', 'model'), 'second');
    const entries = await f.entries(); assert.equal(entries.filter(e => e.event === 'model.request.ended').length, 2);
    assert.equal(entries.find(e => e.event === 'model.request.ended').totalTokens, 3);
    assert.ok(!(await readFile(f.diagnostics.path, 'utf8')).includes('unchanged-replacement'));
  } finally { await f.close(); }
});

test('SDK 流事件顺序和 result 保留，思考与工具参数只计数，终态释放活动请求', async () => {
  const f = await fixture();
  const message = { stopReason: 'stop', usage: { totalTokens: 4 } };
  let resolve!: (message: typeof message) => void;
  const final = new Promise<typeof message>(value => { resolve = value; });
  const events = [{ type: 'start' }, { type: 'thinking_delta', delta: 'private-reasoning' }, { type: 'toolcall_delta', delta: 'private-code' }, { type: 'done' }];
  const raw = { streamSimple: () => ({ result: () => final, async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
    resolve(message);
  } }) } as unknown as ModelRuntime;
  try {
    const stream = observedModelRuntime(() => raw, 'session', f.diagnostics).streamSimple({ api: 'openai-responses' } as never, { messages: [] });
    const delivered = []; for await (const event of stream) delivered.push(event);
    assert.deepEqual(delivered, events); assert.equal(await stream.result(), message);
    await Promise.resolve(); f.diagnostics.sample();
    const entries = await f.entries(), end = entries.find(e => e.event === 'model.request.ended');
    assert.equal(end.thinkingChars, 'private-reasoning'.length); assert.equal(end.toolArgumentChars, 'private-code'.length);
    assert.equal(entries.filter(e => e.event === 'model.first_output').length, 1);
    assert.equal(entries.filter(e => e.event === 'service.heartbeat').at(-1).activeRequests, 0);
    assert.ok(!(await readFile(f.diagnostics.path, 'utf8')).includes('private-reasoning'));
  } finally { await f.close(); }
});

test('真实 factory 将观测代理交给 SDK，创建与打开均订阅执行阶段且释放订阅', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { DefaultPiCoordinatorSessionFactory } = await import('../src/runtime/executors/pi-session-factory.js');
  const f = await fixture(), cwd = join(f.root, 'work'), agentDir = join(f.root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const model = { provider: 'test', id: 'model', api: 'openai-responses', baseUrl: 'https://model.example/v1' };
  const runtime = { getModel: () => model, hasConfiguredAuth: () => true, getAuth: async () => ({ auth: {} }),
    completeSimple: async () => ({ stopReason: 'stop', usage: { totalTokens: 1 } }) } as unknown as ModelRuntime;
  let subscriptions = 0;
  const factory = new DefaultPiCoordinatorSessionFactory({ createModelRuntime: async () => runtime, createAgentSession: async options => {
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      sessionId: options.sessionManager!.getSessionId(), sessionFile: options.sessionManager!.getSessionFile(), model, thinkingLevel: 'off', isStreaming: false, isIdle: true,
      sessionManager: options.sessionManager, getActiveToolNames: () => [...options.tools!],
      prompt: async () => {
        listener?.({ type: 'agent_start', private: 'private-prompt' });
        listener?.({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'call', args: { private: 'private-code' } });
        await options.modelRuntime!.completeSimple(model as never, { messages: [] });
        listener?.({ type: 'agent_end' });
      }, subscribe: (callback: (event: unknown) => void) => { subscriptions += 1; listener = callback; return () => { subscriptions -= 1; listener = undefined; }; }, dispose: () => {},
    };
    return { session: session as never, extensionsResult: options.resourceLoader!.getExtensions() };
  } });
  const config = { systemPrompt: 'test', authorizedContext: [], model: { provider: 'test', modelId: 'model', thinkingLevel: 'off' as const },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 250 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
  try {
    const input = { cwd, agentDir, sessionDir: join(f.root, 'sessions'), config, assistantSessionId: 'session', executionDiagnostics: f.diagnostics };
    const created = await factory.create(input); await created.session.prompt('private-prompt');
    const path = created.session.sessionFile!; created.session.dispose(); assert.equal(subscriptions, 0);
    const opened = await factory.open({ ...input, sessionPath: path }); await opened.session.prompt('private-prompt'); opened.session.dispose();
    assert.equal(subscriptions, 0);
    const entries = await f.entries();
    assert.equal(entries.filter(e => e.event === 'model.request.started').length, 2);
    assert.equal(entries.filter(e => e.event === 'execution.agent_start').length, 2);
    assert.ok(!(await readFile(f.diagnostics.path, 'utf8')).includes('private-code'));
  } finally { await f.close(); }
});

test('真实 Pi SDK 本地 SSE 保留流式回复及网络取消，关联响应 ID、字节、输出和终态', async () => {
  const { createServer } = await import('node:http');
  const { mkdir } = await import('node:fs/promises');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { DefaultPiCoordinatorSessionFactory } = await import('../src/runtime/executors/pi-session-factory.js');
  const f = await fixture(), cwd = join(f.root, 'work'), agentDir = join(f.root, 'agent'), authPath = join(agentDir, 'auth.json');
  await mkdir(cwd); await mkdir(agentDir);
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'private-test-key' } }), { mode: 0o600 });
  let calls = 0, stall = false, connectionClosed = false;
  const server = createServer((request, response) => {
    calls += 1; request.resume();
    if (stall) response.on('close', () => { connectionClosed = true; });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req-real-sdk' });
    const chunk = (delta: object, finish_reason: string | null) => ({ id: 'local', object: 'chat.completion.chunk', created: 1,
      model: 'gpt-4.1-mini', choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk(stall ? { role: 'assistant' } : { role: 'assistant', content: 'hello' }, null))}\n\n`);
    if (!stall) { response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`); response.end('data: [DONE]\n\n'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`;
  const factory = new DefaultPiCoordinatorSessionFactory({ authPath,
    createModelRuntime: options => ModelRuntime.create({ ...options, modelsStorePath: join(f.root, 'catalog.json') }) });
  let session: import('../src/runtime/executors/pi-session-factory.js').PiCoordinatorAgentSession | undefined;
  try {
    const result = await factory.create({ cwd, agentDir, sessionDir: join(f.root, 'sessions'), assistantSessionId: 'session', executionDiagnostics: f.diagnostics,
      config: { systemPrompt: 'Reply hello.', authorizedContext: [], model: { source: 'controlled', profileId: 'local', provider: 'openai', modelId: 'gpt-4.1-mini',
        protocol: 'openai-completions', endpoint, resolvedEndpoint: endpoint, thinkingLevel: 'off' },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 250 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } } });
    session = result.session; await session.prompt('private-test-input');
    assert.equal(calls, 1);
    const entries = await f.entries();
    const start = entries.find(e => e.event === 'model.request.started'), end = entries.find(e => e.event === 'model.request.ended');
    assert.equal(end.requestId, start.requestId); assert.equal(end.stopReason, 'stop'); assert.equal(end.textChars, 5);
    assert.ok(end.bodyBytes > 0); assert.ok(end.firstOutputAt !== null);
    assert.equal(entries.find(e => e.event === 'model.http.headers').responseIds['x-request-id'], 'req-real-sdk');
    assert.ok(session.getActiveBranch().some(entry => entry.type === 'message' && entry.message.role === 'assistant'));
    stall = true;
    const pending = session.prompt('private-test-input').catch(error => error);
    let headersReceived = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      headersReceived = (await f.entries()).filter(e => e.event === 'model.http.first_body').length === 2;
      if (headersReceived) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(headersReceived); await session.abort(); await pending;
    for (let attempt = 0; attempt < 100 && !connectionClosed; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(connectionClosed, 'SDK abort 应关闭仍在等待正文的真实连接');
    assert.equal((await f.entries()).filter(e => e.event === 'model.request.ended').at(-1).stopReason, 'aborted');
    const log = await readFile(f.diagnostics.path, 'utf8'); assert.ok(!log.includes('private-test-key')); assert.ok(!log.includes('private-test-input'));
  } finally {
    session?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close();
  }
});

test('应用日志关联命令终态与任务状态，应用关闭记录心跳收尾', async () => {
  const { createMultivacApplication } = await import('../src/bootstrap/application.js');
  const { testApplicationEnvironment } = await import('./fixtures/test-environment.js');
  const root = await mkdtemp(join(tmpdir(), 'multivac-app-diagnostics-'));
  const app = createMultivacApplication(testApplicationEnvironment(root)); let closed = false;
  try {
    await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(app.server.address() as import('node:net').AddressInfo).port}`;
    const post = async (path: string, data: unknown) => {
      const response = await fetch(endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      assert.ok(response.ok, await response.text());
    };
    await post('/api/sessions', { sessionId: 'observed-session', title: 'private-title' });
    await post('/api/sessions/observed-session/turns', { commandId: 'observed-command', assistantSessionId: 'observed-session', contextRefs: [], text: 'private-input' });
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await readFile(join(app.paths.dataDir, 'diagnostics', 'execution.jsonl'), 'utf8')).includes('assistant.run.succeeded');
      if (completed) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(completed, '真实命令终态应进入诊断日志');
    const task = app.tasks.create({ commandId: 'diagnostic-task', title: 'private-task-title', goal: 'private-goal' }).task;
    await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); closed = true;
    const log = await readFile(join(app.paths.dataDir, 'diagnostics', 'execution.jsonl'), 'utf8');
    const entries = log.trim().split('\n').map(line => JSON.parse(line));
    const success = entries.find(e => e.event === 'assistant.run.succeeded');
    assert.equal(success.executionId, 'observed-command'); assert.equal(success.sessionId, 'observed-session');
    assert.equal(entries.find(e => e.event === 'task.state' && e.taskId === task.taskId).status, 'idle');
    assert.equal(entries.at(-1).event, 'service.closed');
    for (const value of ['private-input', 'private-title', 'private-task-title', 'private-goal']) assert.ok(!log.includes(value));
  } finally {
    if (!closed) { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK 终态早于事件队列消费时，结束日志等待实际交付完成而不漏计', async () => {
  const f = await fixture();
  const message = { stopReason: 'stop' };
  const runtime = { streamSimple: () => ({ result: () => Promise.resolve(message), async *[Symbol.asyncIterator]() {
    yield { type: 'start' }; yield { type: 'text_delta', delta: 'abc' }; yield { type: 'toolcall_delta', delta: 'de' };
  } }) } as unknown as ModelRuntime;
  try {
    const stream = observedModelRuntime(() => runtime, 'session', f.diagnostics).streamSimple({ api: 'openai-responses' } as never, { messages: [] });
    const iterator = stream[Symbol.asyncIterator](); await iterator.next();
    assert.equal(await stream.result(), message);
    f.diagnostics.sample(); assert.equal((await f.entries()).filter(e => e.event === 'service.heartbeat').at(-1).activeRequests, 1);
    while (!(await iterator.next()).done) { /* 消费剩余 SDK 事件，不提前读取模型正文。 */ }
    const end = (await f.entries()).find(e => e.event === 'model.request.ended');
    assert.equal(end.textChars, 3); assert.equal(end.toolArgumentChars, 2); assert.equal(end.modelEvents, 3);
  } finally { await f.close(); }
});
