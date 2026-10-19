import test from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpManagementService } from '../src/application/mcp-management-service.js';
import { createMcpRequestHandler } from '../src/adapters/http/mcp-routes.js';
import { remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';
import assert from 'node:assert/strict';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpResourceService, resourceText, resourceUri, assertResourceUri } from '../src/application/mcp-resource-service.js';
import { McpRuleService } from '../src/modules/mcp/rules.js';
import { assistantQuoteDetails, readAssistantQuoteDetails, renderAssistantQuoteForModel, ASSISTANT_QUOTE_CUSTOM_TYPE } from '../src/runtime/executors/pi-quote-carriage.js';
import { mapPiActiveBranch } from '../src/runtime/executors/pi-message-history.js';
import { resourceQuote } from '../../web/src/features/mcp/mcp-resource-picker.js';
import { sameQuote } from '../../web/src/features/assistant/message-quote.js';
import { parsePendingCommand, pendingDraftRestoration, type PendingCommand } from '../../web/src/features/assistant/pending-command.js';
import { mcpExecutionFixture, until } from './fixtures/mcp-execution-fixture.js';
import { mcpTemporaryDirectory } from './fixtures/mcp-fixture.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { AssistantTurnCommandService } from '../src/application/assistant-turn-command-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const f = await mcpExecutionFixture({ resources: true }), resources = new McpResourceService(f.repository, f.connections, f.host);
  const selection = { sessionId: 'session', connectionId: f.live.connection.connectionId, catalogVersion: f.live.catalog.version, uri: 'fixture://resource/main', parameters: {} };
  const input = (commandId: string) => ({ ...selection, commandId, fingerprint: resources.preview(selection).fingerprint });
  return { ...f, resources, selection, input };
}

test('MCP 资源本地 HTTP 入口校验选择和读取确认参数；公开查询不读取正文，远程入口拒绝', async () => {
  const f = await fixture();
  try {
    const handler = createMcpRequestHandler({} as McpManagementService, f.resources);
    async function request(route: string, input?: unknown) {
      const req = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: '/api/mcp' + route, method: input === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' } }) as IncomingMessage;
      let status = 0, text = ''; const response = { writeHead(value: number) { status = value; }, end(value: string) { text = value; } } as unknown as ServerResponse;
      assert.equal(await handler(req, response), true); return { status, value: JSON.parse(text) };
    }
    const list = await request('/resources?sessionId=session&offset=0&limit=1'); assert.equal(list.status, 200); assert.equal(list.value.total, 4);
    const preview = await request('/resource-preview', f.selection); assert.equal(preview.status, 200); assert.equal(f.sent.some(message => message.method === 'resources/read'), false);
    assert.equal((await request('/resource-read', { ...f.input('http-bad'), approved: true })).status, 400);
    const input = f.input('http-read'), read = await request('/resource-read', input); assert.equal(read.status, 200); assert.equal(read.value.status, 'succeeded');
    assert.deepEqual((await request('/resource-result', input)).value, read.value);
    assert.equal(remoteRouteAllowed('POST', '/api/mcp/resource-read'), false); assert.equal(remoteRouteAllowed('GET', '/api/mcp/resources'), false);
  } finally { await f.dispose(); }
});

test('MCP 资源/模板真实分页发现，选择不读取；读取及稳定回执、不可变旧快照和单独外传规则', async () => {
  const f = await fixture();
  try {
    assert.equal(f.live.catalog.resources.length, 2); assert.equal(f.live.catalog.resourceTemplates.length, 2);
    assert.equal(f.sent.filter(message => message.method === 'resources/list').length, 2);
    const first = f.resources.list('session', 0, 1), next = f.resources.list('session', 1, 1);
    assert.equal(first.total, 4); assert.equal(first.nextOffset, 1); assert.notDeepEqual(first.items, next.items);
    const input = f.input('resource-read'); assert.equal(f.sent.filter(message => message.method === 'resources/read').length, 0);
    const result = await f.resources.read(input); assert.equal(result.status, 'succeeded');
    assert.equal(result.snapshot!.text.includes('fixture-secret'), false); assert.match(result.snapshot!.text, /已隐藏/u);
    const readCount = f.sent.filter(message => message.method === 'resources/read').length;
    assert.deepEqual(await f.resources.read(input), result); assert.equal(f.sent.filter(message => message.method === 'resources/read').length, readCount);
    assert.deepEqual(f.resources.result(input), result);
    const quote = resourceQuote('session', result, result.snapshot!.text)!;
    assert.deepEqual(f.resources.quote('session', quote), quote);
    f.state.resourceText = '后来更新的正文'; const updated = await f.resources.read(f.input('updated-resource'));
    assert.notEqual(updated.snapshot!.snapshotId, result.snapshot!.snapshotId); assert.equal(f.resources.result(input).snapshot!.text, result.snapshot!.text);
    assert.equal(f.resources.quote('session', quote).text, result.snapshot!.text);
    assert.throws(() => f.resources.quote('other-session', quote), /跨会话/u);
    assert.throws(() => f.resources.quote('session', { ...quote, text: '伪造未读取内容' }), /不匹配/u);
    assert.throws(() => f.resources.quote('session', { ...quote, sourceMcp: { ...quote.sourceMcp, accountId: 'other' } }), /不匹配/u);
    f.context.hostEffects = ['read'];
    assert.equal(f.resources.preview(f.selection).uri, f.selection.uri);
    assert.throws(() => f.resources.quote('session', quote), /不允许/u);
    f.context.hostEffects = ['read', 'data-transfer'];
    new McpRuleService(f.repository, { validate() {} }).set('resource-disable', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true });
    assert.throws(() => f.resources.preview(f.selection), /停用/u); assert.throws(() => f.resources.quote('session', quote), /不允许/u);
    assert.equal(f.resources.result(input).snapshot!.text, result.snapshot!.text);
  } finally { await f.dispose(); }
});

test('MCP 资源模板参数严格核对；文件 URI、超大和二进制内容受边界限制', async () => {
  const f = await fixture();
  try {
    const template = { ...f.selection, uri: undefined, template: 'fixture://resource/{id}', parameters: { id: 'a/b 中文' } };
    const { uri: _none, ...selection } = template;
    const preview = f.resources.preview(selection); assert.equal(preview.uri, 'fixture://resource/a%2Fb%20%E4%B8%AD%E6%96%87');
    const result = await f.resources.read({ ...selection, commandId: 'template-read', fingerprint: preview.fingerprint }); assert.equal(result.snapshot!.uri, preview.uri);
    assert.throws(() => resourceUri({ ...selection, parameters: {} }, [], [selection.template]), /全部/u);
    assert.throws(() => resourceUri({ ...selection, template: 'fixture://resource/{+id}' }, [], ['fixture://resource/{+id}']), /仅支持/u);
    assert.throws(() => f.resources.preview({ ...f.selection, uri: 'file:///outside/secret' }), /目录/u);
    for (const value of [{ uri: f.selection.uri, blob: 'c2VjcmV0', mimeType: 'image/png' }, { uri: 'fixture://other', text: '越界正文' }, { uri: f.selection.uri, text: '内容', mimeType: 'application/octet-stream' }]) assert.throws(() => resourceText({ contents: [value] }, f.selection.uri), /不受支持/u);
    f.state.resourceText = '中'.repeat(20_000); const large = await f.resources.read(f.input('large'));
    assert.equal(large.snapshot!.truncated, true); assert.ok(Buffer.byteLength(large.snapshot!.text) <= 32_000); assert.equal(large.snapshot!.text.includes('\ufffd'), false);
    assert.equal(resourceQuote('session', large, large.snapshot!.text), null);
    const quote = resourceQuote('session', large, '中'.repeat(100))!; assert.equal(f.resources.quote('session', quote).text.length, 100);
    f.state.resourceMimeType = 'image/png'; const invalid = f.input('invalid-type'); await assert.rejects(f.resources.read(invalid), /不受支持/u);
    assert.equal(f.resources.result(invalid).status, 'unknown'); const count = f.sent.length; await f.resources.read(invalid); assert.equal(f.sent.length, count);
  } finally { await f.dispose(); }
});

test('MCP 资源读取目录或账号变化拒绝，异步准备后规则收紧不发送；断线未知不重发', async () => {
  const f = await fixture();
  try {
    const stale = f.input('stale'); f.state.resourceRevision++;
    await assert.rejects(f.resources.read(stale), /目录|范围/u);
    assert.equal(f.sent.some(message => message.method === 'resources/read'), false);
    f.state.resourceRevision--; await f.connections.refresh(f.live.connection.connectionId, 'session');
    const input = f.input('delayed'); let release!: () => void, waiting = false;
    f.host.redactor = async () => { waiting = true; await new Promise<void>(resolve => { release = resolve; }); return text => text; };
    const pending = f.resources.read(input), rejected = assert.rejects(pending, /停用|范围/u); await until(() => waiting);
    new McpRuleService(f.repository, { validate() {} }).set('deny-read', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true }); release(); await rejected;
    assert.equal(f.resources.result(input).status, 'not-started'); assert.equal(f.sent.some(message => message.method === 'resources/read'), false);
  } finally { await f.dispose(); }
  const g = await fixture();
  try {
    const input = g.input('disconnect'); g.state.hangResource = true;
    const pending = g.resources.read(input), rejected = assert.rejects(pending, /连接中断/u);
    await until(() => g.sent.some(message => message.method === 'resources/read')); await g.connections.closeSession('session'); await rejected;
    assert.equal(g.resources.result(input).status, 'unknown'); const count = g.sent.length; await g.resources.read(input); assert.equal(g.sent.length, count);
    g.repository.commit('revoke-resource-account', 'a'.repeat(64), new Date().toISOString(), tx => tx.put('account', { ...g.account, revision: 2, state: 'revoked' }, 1));
    assert.equal(g.resources.list('session').total, 0);
  } finally { await g.dispose(); }
});

test('MCP 资源文件 URI 核对真实目录及符号链接；已读引用在账号、项目或宿主变化后不能发送', async () => {
  const root = mcpTemporaryDirectory('resource-boundary-');
  try {
    const work = path.join(root, 'work'); mkdirSync(work); writeFileSync(path.join(work, 'allowed.txt'), '获准'); writeFileSync(path.join(root, 'outside.txt'), '范围外'); symlinkSync(path.join(root, 'outside.txt'), path.join(work, 'escape.txt'));
    assertResourceUri(pathToFileURL(path.join(work, 'allowed.txt')).href, work, true);
    assert.throws(() => assertResourceUri(pathToFileURL(path.join(work, 'escape.txt')).href, work, true), /超出/u);
    assert.throws(() => assertResourceUri(pathToFileURL(path.join(root, 'outside.txt')).href, work, true), /超出/u);
    assert.throws(() => assertResourceUri(pathToFileURL(path.join(work, 'allowed.txt')).href, work, false), /超出/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const change of ['account', 'project', 'host'] as const) {
    const f = await fixture();
    try {
      const input = f.input(`identity-${change}`), result = await f.resources.read(input), quote = resourceQuote('session', result, '资源正文')!;
      if (change === 'account') f.repository.commit('resource-account-revoked', 'b'.repeat(64), new Date().toISOString(), tx => tx.put('account', { ...f.account, revision: 2, state: 'revoked' }, 1));
      if (change === 'project') f.context.projectId = 'different-project';
      if (change === 'host') f.context.host = 'coordinator';
      assert.throws(() => f.resources.quote('session', quote), /变化|宿主/u);
      assert.equal(f.resources.result(input).snapshot!.snapshotId, result.snapshot!.snapshotId);
    } finally { await f.dispose(); }
  }
});

test('MCP 资源快照经原引用草稿、未知发送恢复与 Pi custom entry 保留来源，不混用相同正文的其他快照', async () => {
  const f = await fixture();
  try {
    const result = await f.resources.read(f.input('draft')), quote = resourceQuote('session', result, result.snapshot!.text)!;
    const other = await f.resources.read(f.input('other-draft')), otherQuote = resourceQuote('session', other, other.snapshot!.text)!;
    assert.equal(sameQuote(quote, otherQuote), false);
    const pending: PendingCommand = { commandId: 'send-resource', generation: 1, text: '解释这段资料', quote, contextRefs: [], draftVersion: 2, cleared: false, unknown: true, streamingBehavior: null };
    const restored = parsePendingCommand(JSON.stringify(pending)); assert.deepEqual(restored?.quote, quote);
    assert.deepEqual(pendingDraftRestoration(pending, { draft: '', quote: null }, { draftVersion: 2, latestPrompt: pending }), { kind: 'restore' });
    assert.deepEqual(pendingDraftRestoration({ ...pending, cleared: true }, { draft: pending.text, quote: otherQuote }, { draftVersion: 2, latestPrompt: pending }), { kind: 'keep' });
    const details = assistantQuoteDetails(f.resources.quote('session', quote)); assert.deepEqual(readAssistantQuoteDetails(details), details);
    const rendered = renderAssistantQuoteForModel(quote); assert.match(rendered, /第三方资料/u); assert.match(rendered, /readAt/u); assert.equal(rendered.includes('fixture-secret'), false);
    const entries = [{ type: 'custom_message', id: 'quote', parentId: null, customType: ASSISTANT_QUOTE_CUSTOM_TYPE, content: rendered, display: false, details, timestamp: result.snapshot!.readAt }, { type: 'message', id: 'user', parentId: 'quote', message: { role: 'user', content: pending.text, timestamp: 0 }, timestamp: result.snapshot!.readAt }] as unknown as SessionEntry[];
    assert.deepEqual(mapPiActiveBranch('runtime', entries)[0]!.quote, quote);
  } finally { await f.dispose(); }
});

test('MCP 引用经真实发送服务进入 Fake 历史；认证等待后规则变化拒绝 handoff 并保留引用草稿', async () => {
  const f = await fixture(), store = new SqliteAssistantStore(':memory:'), adapter = new FakeCoordinatorAdapter({ promptDelayMs: 0, seedsHistory: () => false });
  try {
    store.sessions.insertIfAbsent({ sessionId: 'session', title: '资源引用发送', kind: 'work', workspaceId: store.sessions.listAll()[0]!.workspaceId, createdAt: new Date().toISOString(), workingDirectory: { kind: 'session-temp', path: '/workspace' } });
    const quote = resourceQuote('session', await f.resources.read(f.input('send')), '资源正文')!;
    const sessions = new AssistantSessionService({ assistantSessionId: 'session', kind: 'work', resolveWorkingDirectory: () => ({ kind: 'session-temp', path: '/workspace' }), adapter, bindingRepository: store.bindings, pageStateRepository: store.pageStates, eventRepository: store.events,
      runtimeConfig: { systemPrompt: '', authorizedContext: [], model: { provider: 'fake', modelId: 'fake', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 } } });
    await sessions.initialize(); let tighten = false;
    const commands = new AssistantTurnCommandService({ assistantSessionId: 'session', sessionService: sessions, adapter, commandRepository: store.commands, eventStream: new AssistantEventStream(),
      resolveMcpQuote: value => f.resources.quote('session', value), assertMcpQuoteForDispatch: (value, commandId) => { f.resources.quote('session', value, commandId); },
      withSelectionForSend: async dispatch => { if (tighten) new McpRuleService(f.repository, { validate() {} }).set('tighten-at-dispatch', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true }); return { value: dispatch() }; } });
    const command = { commandId: 'send-resource-1', assistantSessionId: 'session', text: '解释资料', contextRefs: [], quote };
    const first = await commands.send(command); assert.equal(first.status, 'terminal');
    const history = adapter.readActiveBranch('session'); assert.equal(history.ok, true); assert.deepEqual(history.ok && history.value.messages.find(message => message.role === 'user')?.quote, quote);
    assert.deepEqual(await commands.send(command), first);
    tighten = true; const refused = await commands.send({ ...command, commandId: 'send-resource-2' }); assert.equal(refused.terminalOutcome, 'rejected');
    const final = adapter.readActiveBranch('session'); assert.equal(final.ok && final.value.messages.filter(message => message.role === 'user').length, 1);
  } finally { adapter.dispose(); store.close(); await f.dispose(); }
});
