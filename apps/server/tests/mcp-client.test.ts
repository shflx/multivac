import test from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpHttpWire, McpStdioWire, type McpMessage, type McpStdioChannel } from '../src/modules/mcp/client.js';
import { McpConnections } from '../src/modules/mcp/connections.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { mcpAt, mcpFixture } from './fixtures/mcp-fixture.js';

function stdioFixture(overrides: (message: McpMessage) => unknown = () => undefined) {
  let receive: ((bytes: Uint8Array) => void) | undefined;
  let exited: (() => void) | undefined;
  let closed = false;
  const sent: McpMessage[] = [];
  const emit = (message: McpMessage) => {
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    // 跨字节和跨 UTF-8 字符边界传输，核对按行解码。
    receive?.(bytes.subarray(0, bytes.length - 3)); receive?.(bytes.subarray(bytes.length - 3));
  };
  const channel: McpStdioChannel = {
    listen(data, exit) { receive = data; exited = exit; return () => { receive = undefined; }; },
    async write(line) {
      const message: McpMessage = JSON.parse(line); sent.push(message);
      const custom = overrides(message);
      if (custom === 'hang' || !message.method || message.id === undefined) return;
      const result = custom ?? (message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: '测试', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'lookup', description: '中文目录', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : message.method === 'resources/list' ? { resources: [{ name: '资料', uri: 'test://doc' }] }
        : message.method === 'resources/templates/list' ? { resourceTemplates: [] } : { content: [{ type: 'text', text: '完成' }] });
      queueMicrotask(() => emit({ jsonrpc: '2.0', id: message.id, result }));
    },
    async close() { closed = true; exited?.(); },
  };
  return { wire: new McpStdioWire(async () => channel), emit, sent, channel, get closed() { return closed; } };
}

test('MCP stdio 字节流协商、分页发现、变更和服务端采样拒绝', async () => {
  const f = mcpFixture();
  const transport = stdioFixture(message => message.method === 'tools/list' && !Object.hasOwn(message.params as object, 'cursor')
    ? { tools: [], nextCursor: 'page2' } : undefined);
  const changes: string[] = [];
  const client = new McpClient(transport.wire, kind => changes.push(kind));
  try {
    await client.connect();
    const directory = await client.discover({ serviceId: 'service', accountId: 'account', accountRevision: 1, configVersion: f.service.configVersion }, mcpAt);
    assert.equal(directory.tools[0]?.description, '中文目录');
    assert.equal(directory.resources[0]?.uri, 'test://doc');
    assert.equal(transport.sent.filter(message => message.method === 'tools/list').length, 2);
    transport.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    transport.emit({ jsonrpc: '2.0', id: 'sample', method: 'sampling/createMessage', params: { messages: [] } });
    await Promise.resolve();
    assert.ok(changes.includes('catalog'));
    assert.equal(transport.sent.find(message => message.id === 'sample')?.error?.code, -32601);
  } finally { await client.close(); f.close(); }
  assert.equal(transport.closed, true);
});

test('MCP 超时与取消不自动重发，迟到结果不恢复旧执行', async () => {
  const transport = stdioFixture(message => message.method === 'tools/call' ? 'hang' : undefined);
  const client = new McpClient(transport.wire, () => {}, 20);
  try {
    await client.connect();
    await assert.rejects(client.rpc('tools/call', { name: 'write', arguments: {} }), error => (error as { code: string }).code === 'timeout');
    const previous = transport.sent.find(message => message.method === 'tools/call')!;
    transport.emit({ jsonrpc: '2.0', id: previous.id!, result: { content: [] } });
    const cancel = new AbortController();
    const pending = client.rpc('tools/call', { name: 'write', arguments: {} }, cancel.signal);
    cancel.abort();
    await assert.rejects(pending, error => (error as { code: string }).code === 'cancelled');
    assert.equal(transport.sent.filter(message => message.method === 'tools/call').length, 2);
    assert.equal(transport.sent.filter(message => message.method === 'notifications/cancelled').length, 2);
  } finally { await client.close(); }
});

test('MCP Streamable HTTP 逐请求策略、账号头、会话和 SSE 响应', async () => {
  let checks = 0;
  const requests: { method: string; headers: Headers; body: McpMessage | null }[] = [];
  const request: typeof fetch = async (_url, init) => {
    const method = init?.method ?? 'GET', headers = new Headers(init?.headers);
    const message: McpMessage | null = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, headers, body: message });
    assert.equal(init?.redirect, 'error');
    assert.equal(headers.get('Authorization'), 'Bearer private-fixture');
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (!message?.id) return new Response(null, { status: 202 });
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: {} }
      : message.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: '结果' }] };
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'Mcp-Session-Id': 'fixed-session' } });
    return new Response(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\r\n\r\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const client = new McpClient(new McpHttpWire('https://fixture.test/mcp', { async authorize() { checks++; }, async credentials() { return { Authorization: 'Bearer private-fixture' }; } }, request));
  await client.connect();
  assert.deepEqual(await client.rpc('tools/list', {}), { tools: [] });
  await client.close();
  assert.ok(checks >= requests.length);
  assert.equal(requests[2]?.headers.get('Mcp-Session-Id'), 'fixed-session');
  assert.equal(requests[2]?.headers.get('MCP-Protocol-Version'), '2025-06-18');
  assert.equal(requests.at(-1)?.method, 'DELETE');
});

test('MCP 连接绑定会话、账号与配置，目录变更立即失效，旧 SSE 不启动', async () => {
  const f = mcpFixture();
  let opened = 0;
  const transport = stdioFixture();
  const connections = new McpConnections(f.repository, { async open() { opened++; return transport.wire; } }, () => mcpAt);
  try {
    const result = await connections.connect('service', 'account', { sessionId: 'session', host: 'work' });
    assert.equal(result.connection.state, 'connected');
    assert.throws(() => connections.get(result.connection.connectionId, 'other-session'), /连接不可用/);
    transport.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    assert.throws(() => connections.get(result.connection.connectionId, 'session'), /目录已变化/);
    const refreshed = await connections.refresh(result.connection.connectionId, 'session');
    assert.equal(refreshed.version, result.catalog.version);
    assert.notEqual(refreshed.catalogId, result.catalog.catalogId);
    assert.equal(connections.get(result.connection.connectionId, 'session').catalog.catalogId, refreshed.catalogId);
    await connections.closeSession('session');
    assert.equal(connections.stopped('session'), true);
    assert.equal(f.repository.get('connection', result.connection.connectionId)?.state, 'closed');
    const legacy = { kind: 'legacy-sse' as const, url: 'https://fixture.test/sse' };
    f.repository.commit('legacy', mcpFingerprint('legacy'), mcpAt, tx => tx.put('service', { ...f.service, transport: legacy, configVersion: mcpFingerprint(legacy), revision: 2 }, 1));
    await assert.rejects(connections.connect('service', 'account', { sessionId: 'session', host: 'work' }), /不支持旧/);
    assert.equal(opened, 1);
  } finally { f.close(); }
});

test('MCP 目录分页循环、错误协议和 HTTP 重定向失败不降级或重试', async () => {
  const f = mcpFixture();
  const cyclic = stdioFixture(message => message.method === 'tools/list' ? { tools: [], nextCursor: 'again' } : undefined);
  const client = new McpClient(cyclic.wire);
  try {
    await client.connect();
    await assert.rejects(client.discover({ serviceId: 'service', accountId: 'account', accountRevision: 1, configVersion: f.service.configVersion }, mcpAt), /游标无效或重复/);
  } finally { await client.close(); f.close(); }
  let attempts = 0;
  const http = new McpClient(new McpHttpWire('https://fixture.test/mcp', { async authorize() {}, async credentials() { return {}; } }, async () => { attempts++; return new Response(null, { status: 302, headers: { Location: 'https://other.test/' } }); }));
  await assert.rejects(http.connect(), /HTTP 请求被拒绝/);
  assert.equal(attempts, 1);
});
