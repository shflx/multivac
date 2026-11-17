import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, CurrentViewSnapshot } from '@multivac/contracts';
import { createMultivacHttpServer } from '../src/bootstrap/server.js';
import { RemoteAccess } from '../src/adapters/http/remote-access.js';
import { LocalEntryPolicy, localEntries } from '../src/adapters/http/local-entry-policy.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testToolServices } from './fixtures/tool-services.js';

const sessionId = 'global-coordinator';
const view: CurrentViewSnapshot = { panel: 'workspace', narrow: false,
  workspace: { workspaceId: 'project', scene: null, terminalId: 'terminal' }, management: null };
const config: CoordinatorRuntimeConfig = { systemPrompt: 'fixture', authorizedContext: [],
  model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 } };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const completion = deferred();
  const store = new SqliteAssistantStore(':memory:');
  const adapter = new FakeCoordinatorAdapter({ promptDelayMs: 0, promptCompletionBarrier: completion.promise, seedsHistory: () => false });
  const service = new AssistantSessionService({ adapter, bindingRepository: store.bindings, pageStateRepository: store.pageStates,
    eventRepository: store.events, runtimeConfig: config, resolveWorkingDirectory: () => ({ kind: 'session-temp', path: process.cwd() }) });
  const eventStream = new AssistantEventStream();
  const commands = new AssistantTurnCommandService({ sessionService: service, adapter, commandRepository: store.commands, eventStream });
  const token = 'isolated-fixture-token-at-least-32-bytes';
  const access = new RemoteAccess({ enabled: true, token, origin: '', host: '0.0.0.0' }, Date.now, 'multivac_remote', new LocalEntryPolicy(localEntries('production', 4317)));
  // 通过真实 HTTP factory 分发，但不监听端口、不启动外部服务。
  const server = createMultivacHttpServer({ service, commandService: commands, eventRepository: store.events, eventStream, remoteAccess: access });
  let reads = 0, opens = 0, terminalLookups = 0;
  const tools = new InternalToolService({ tools: MULTIVAC_INTERNAL_TOOLS, calls: store.internalToolCalls,
    services: testToolServices({
      projects: { listWorkspaces: () => ({ workspaces: [{ workspaceId: 'project', name: 'fixture', project: { projectId: 'project', name: 'fixture' } }] }) },
      sessions: { list: () => ({ sessions: [] }), presentedScene: () => ({ scene: { parallelCount: 1, viewMode: 'focus', slots: [], focusedSessionId: null } }) },
      terminals: { readScreen: async () => { reads++; return { text: 'fixture screen' }; },
        get: () => { terminalLookups++; return { terminalId: 'terminal', projectId: 'project', title: 'fixture terminal',
          preset: { kind: 'codex', argv: [] }, agentSessionId: 'fixture-cli', status: 'running', closedAt: null }; },
        open: async () => { opens++; throw new Error('fixture stopped'); } },
      terminalTranscripts: { readSnapshot: () => { reads++; return { runtimeSessionId: 'fixture', leafEntryId: null, branchEntryIds: [], messages: [] }; } },
    } as unknown as InternalToolServices),
    currentTurn: () => commands.currentPromptCommandId() ? {
      commandId: commands.currentPromptCommandId()!, windowId: commands.currentPromptWindowId(), view: commands.currentPromptView(),
      // 仅隔离 fixture 读取服务端来源标记；可在修复前的快照复现，公共 JSON 无权设置它。
      terminalAccessAllowed: commands.currentPromptAllowsTerminalAccess?.(),
      updateView: next => commands.updatePromptView(commands.currentPromptCommandId()!, next),
    } : null });
  let sequence = 0;
  const invoke = (toolName = 'read_terminal_screen') => tools.invoke({ assistantSessionId: sessionId, toolCallId: `fixture-${sequence++}`, toolName,
    args: toolName === 'get_current_view' ? {} : toolName === 'open_terminal' ? { projectId: 'project', preset: 'blank' } : { terminalId: 'terminal' } }, new AbortController().signal);
  type RequestOptions = { behavior?: 'steer' | 'followUp'; origin?: string | null; mobile?: boolean; mobileHint?: boolean; host?: string; remote?: boolean; narrow?: boolean; noView?: boolean; forged?: boolean };
  let remoteCookie = '';
  function dispatch(body: unknown, options: RequestOptions, path = '/api/assistant/turns') {
    const headers: Record<string, string> = { host: options.host ?? (options.remote ? 'remote.example' : 'localhost:4317'), 'content-type': 'application/json', 'user-agent': options.mobile ? 'iPhone Mobile' : 'Desktop', 'x-multivac-window-id': 'window' };
    if (options.origin !== null) headers.origin = options.origin ?? (options.remote ? 'http://remote.example' : 'http://localhost:4317');
    if (options.mobileHint) headers['sec-ch-ua-mobile'] = '?1';
    if (options.remote && remoteCookie) headers.cookie = remoteCookie;
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path, headers,
      socket: { remoteAddress: options.remote ? '192.168.1.5' : '127.0.0.1', localPort: 4317 } }) as unknown as IncomingMessage;
    const ended = deferred();
    const result = { status: 0, body: '', headers: {} as Record<string, string | string[]> };
    const res = { destroyed: false, writableEnded: false, setHeader(name: string, value: string | string[]) { result.headers[name] = value; },
      writeHead(status: number, values?: Record<string, string | string[]>) { result.status = status; Object.assign(result.headers, values); },
      end(text: string) { result.body = text; ended.resolve(); } } as unknown as ServerResponse;
    server.emit('request', req, res);
    return { done: ended.promise, result };
  }
  const login = dispatch({ token }, { remote: true }, '/api/access/login');
  await login.done;
  assert.equal(login.result.status, 200);
  remoteCookie = String(login.result.headers['set-cookie']).split(';')[0]!;
  function send(options: RequestOptions = {}) {
    const body = { commandId: `send-${sequence++}`, assistantSessionId: sessionId, text: '普通聊天', contextRefs: [],
      ...(options.behavior ? { streamingBehavior: options.behavior } : {}),
      ...(options.noView ? {} : { view: { ...view, narrow: options.narrow ?? false } }),
      ...(options.forged ? { terminalAccessAllowed: true } : {}) };
    return { ...dispatch(body, options), commandId: body.commandId };
  }
  async function streaming() {
    for (let count = 0; count < 100; count++) {
      const result = adapter.isStreaming(sessionId);
      if (result.ok && result.value) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail('fixture 未进入 streaming');
  }
  return { commands, adapter, invoke, send, streaming, completion, effects: () => ({ reads, opens }), lookups: () => terminalLookups,
    close() { completion.resolve(); server.close(() => {}); adapter.dispose(); store.close(); } };
}

for (const [name, options, allowed] of [
  ['本机完整来源', {}, true], ['缺少 Origin', { origin: null }, false],
  ['移动 UA', { mobile: true }, false], ['移动提示头', { mobileHint: true }, false],
  ['无 Origin 普通聊天且无 view', { origin: null, noView: true }, false],
  ['远程普通聊天', { remote: true, noView: true }, false], ['窄屏', { narrow: true }, false],
] as const) test(`HTTP 来源：${name}，普通聊天可受理，终端权限独立核对`, async () => {
  const f = await fixture();
  const prompt = f.send(options);
  try {
    await f.streaming();
    assert.equal((await f.invoke()).ok, allowed);
    assert.equal((await f.invoke('read_terminal_recent')).ok, allowed);
    const opened = await f.invoke('open_terminal');
    assert.equal(opened.ok, false);
    const beforeView = f.lookups();
    const current = await f.invoke('get_current_view');
    assert.equal(current.ok, !('noView' in options && options.noView));
    if (current.ok) {
      if (allowed) assert.match(current.content, /"terminalId":"terminal"/u);
      else assert.doesNotMatch(current.content, /"terminalId"|fixture terminal|read_terminal_/u);
    }
    assert.equal(f.lookups(), beforeView + (allowed ? 1 : 0));
    if (!allowed) assert.equal(beforeView, 0);
    assert.deepEqual(f.effects(), { reads: allowed ? 2 : 0, opens: allowed ? 1 : 0 });
  } finally { f.completion.resolve(); await prompt.done; f.close(); }
  assert.equal(prompt.result.status, 200);
});

for (const behavior of ['steer', 'followUp'] as const) for (const origin of ['remote', 'missing'] as const) test(`HTTP ${behavior}：${origin} 追加在 adapter handoff 前撤销，本轮不可恢复，新 prompt 可恢复`, async () => {
  const f = await fixture();
  const prompt = f.send();
  try {
    await f.streaming();
    assert.equal((await f.invoke()).ok, true);
    const localView = await f.invoke('get_current_view');
    assert.equal(localView.ok, true, JSON.stringify(localView));
    if (localView.ok) assert.match(localView.content, /"terminalId":"terminal"/u);
    assert.equal(f.lookups(), 1);
    // 本机追加保持权限。
    const local = f.send({ behavior }); await local.done;
    assert.equal(local.result.status, 200);
    assert.equal((await f.invoke()).ok, true);
    const original = f.adapter[behavior].bind(f.adapter);
    const entered = deferred(), release = deferred();
    let observed: boolean[] = [];
    let observedView!: Awaited<ReturnType<typeof f.invoke>>;
    const effectsBefore = f.effects();
    f.adapter[behavior] = async (...args: Parameters<typeof original>) => {
      observed = [(await f.invoke()).ok, (await f.invoke('read_terminal_recent')).ok, (await f.invoke('open_terminal')).ok];
      observedView = await f.invoke('get_current_view');
      entered.resolve();
      await release.promise;
      return original(...args);
    };
    const remote = f.send(origin === 'remote' ? { behavior, remote: true, noView: true } : { behavior, origin: null });
    try {
      await entered.promise;
      assert.deepEqual(observed, [false, false, false], '追加 Promise 尚未完成时就必须拒绝终端访问');
      assert.equal(observedView.ok, true);
      if (observedView.ok) {
        assert.match(observedView.content, /本轮未获本机终端访问资格/u);
        assert.doesNotMatch(observedView.content, /"terminalId"|fixture terminal|read_terminal_|当前焦点会话/u);
      }
      assert.equal(f.lookups(), 1, '已撤销来源的当前视图不能查询终端元数据');
      assert.deepEqual(f.effects(), effectsBefore, '来源拒绝发生在读取和启动端口之前');
      f.commands.updatePromptView(prompt.commandId, view);
      assert.equal((await f.invoke()).ok, false, '导航视图更新不能恢复权限');
    } finally { release.resolve(); await remote.done; f.adapter[behavior] = original; }
    assert.equal(remote.result.status, 200);
    await f.send({ behavior }).done;
    assert.equal((await f.invoke()).ok, false, '后续本机追加不能恢复本轮权限');
    f.completion.resolve(); await prompt.done;
    const originalPrompt = f.adapter.prompt.bind(f.adapter);
    let nextAllowed: boolean | undefined;
    f.adapter.prompt = async (...args: Parameters<typeof originalPrompt>) => {
      nextAllowed = (await f.invoke()).ok;
      return originalPrompt(...args);
    };
    const next = f.send();
    await next.done;
    assert.equal(nextAllowed, true, '真正新 prompt 可以重新取得本机权限');
  } finally { f.completion.resolve(); await prompt.done; f.close(); }
});

test('HTTP 公共 JSON 不允许伪造终端权限；远程仍不能提交 view', async () => {
  const f = await fixture();
  try {
    const forged = f.send({ origin: null, forged: true }); await forged.done;
    assert.equal(forged.result.status, 400);
    const remote = f.send({ remote: true }); await remote.done;
    assert.equal(remote.result.status, 403);
    assert.deepEqual(f.effects(), { reads: 0, opens: 0 });
  } finally { f.close(); }
});

for (const options of [{ origin: 'http://localhost:9999' }, { origin: 'https://localhost:4317' }, { host: 'localhost:9999' }])
  test(`HTTP factory 拒绝错误 Host/Origin ${JSON.stringify(options)}，不启动聊天也不访问终端`, async () => {
    const f = await fixture();
    try {
      const invalid = f.send(options); await invalid.done;
      assert.equal(invalid.result.status, 403);
      assert.equal(f.commands.currentPromptCommandId(), null);
      assert.equal(f.adapter.calls.some(call => call.method === 'prompt'), false);
      assert.deepEqual(f.effects(), { reads: 0, opens: 0 });
    } finally { f.close(); }
  });
