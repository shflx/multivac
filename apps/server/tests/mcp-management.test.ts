import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpAccount, McpImportPreview, McpService } from '@multivac/contracts';
import { McpAccountService } from '../src/application/mcp-account-service.js';
import { McpManagementService, parseMcpConfig } from '../src/application/mcp-management-service.js';
import { createMcpRequestHandler } from '../src/adapters/http/mcp-routes.js';
import { remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';
import { McpConnections } from '../src/modules/mcp/connections.js';
import { mcpWireFactory } from '../src/runtime/executors/mcp-wire-factory.js';
import type { McpPrivateCredentials } from '../src/modules/mcp/credentials.js';
import { mcpExecutionFixture, until } from './fixtures/mcp-execution-fixture.js';

async function fixture() {
  const f = await mcpExecutionFixture(), values = new Map<string, McpPrivateCredentials>(), events: string[] = [];
  const accounts = new McpAccountService(f.repository, { instanceId: 'management-test', async read(ref) { return values.get(ref) ?? null; }, async modify(ref, operation) { const next = await operation(values.get(ref) ?? null); if (next) values.set(ref, next); else values.delete(ref); } }, { async authorize() {}, async request() { throw Error('不得外连'); } }, 'http://127.0.0.1:43123/api/mcp/oauth/callback');
  const management = new McpManagementService(f.repository, accounts, f.mcp, f.host, { validate(target, readOnly) { if (target.kind === 'project' && target.projectId !== 'project' || target.kind === 'session' && target.sessionId === 'archived' && !readOnly) throw Error('归属不可修改'); } }, id => events.push(id));
  const handler = createMcpRequestHandler(management);
  async function request<T = unknown>(path: string, input?: unknown) {
    const request = Object.assign(Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]), { url: `/api/mcp${path}`, method: input === undefined ? 'GET' : 'POST', headers: { host: '127.0.0.1:43123', 'content-type': 'application/json' } }) as IncomingMessage;
    let status = 0, raw = '';
    const response = { writeHead(code: number) { status = code; }, end(value: string) { raw = value; } } as unknown as ServerResponse;
    assert.equal(await handler(request, response), true);
    return { status, raw, body: JSON.parse(raw) as T };
  }
  return { ...f, management, accounts, request, values, events };
}

test('MCP 配置导入不执行、不接受秘密字段，确认停用登记且版本冲突保留新配置', async () => {
  const f = await fixture();
  try {
    const before = f.state.opened;
    const config = JSON.stringify({ mcpServers: { demo: { command: '/absolute/fixture', args: ['--mode', 'read'], env: { TOKEN: '' } } } });
    const preview = await f.request<McpImportPreview[]>('/preview', { commandId: 'preview', config, source: '用户选择的文件' });
    assert.equal(preview.status, 200); assert.equal(f.state.opened, before);
    const saved = await f.request<McpService>('/confirm', { commandId: 'confirm', previewId: preview.body[0]!.previewId });
    assert.equal(saved.status, 200); assert.equal(saved.body.enabled, false); assert.equal(f.state.opened, before);
    const replay = await f.request<McpService>('/confirm', { commandId: 'confirm', previewId: preview.body[0]!.previewId });
    assert.equal(replay.body.serviceId, saved.body.serviceId);
    const edit = f.management.preview({ commandId: 'edit', serviceId: saved.body.serviceId, revision: 1, source: '显式编辑', config });
    await f.management.state('enable', saved.body.serviceId, 1, 'enable');
    await assert.rejects(f.management.confirm('stale-confirm', edit[0]!.previewId), /版本已变化/u);
    assert.equal(f.repository.get('service', saved.body.serviceId)?.enabled, true);
    for (const raw of [{ command: '/fixture', env: { TOKEN: 'secret-never-public' } }, { url: 'https://fixture.test/mcp', headers: { Authorization: 'Bearer secret-never-public' } }, { command: '/fixture', args: ['--token', 'secret-never-public'] }]) {
      const rejected = await f.request('/preview', { commandId: 'private-preview', source: '用户粘贴', config: JSON.stringify({ mcpServers: { demo: raw } }) });
      assert.equal(rejected.status, 400); assert.equal(rejected.raw.includes('secret-never-public'), false);
    }
    assert.throws(() => parseMcpConfig('{"mcpServers":{"demo":{"command":"/fixture","environmentKeys":"TOKEN"}}}'));
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM mcp_fact').all()).includes('secret-never-public'), false);
    assert.equal(remoteRouteAllowed('POST', '/api/mcp/connect'), false);
    assert.equal(remoteRouteAllowed('GET', '/api/mcp/account-status'), false);
    await f.management.state('remove', saved.body.serviceId, 2, 'remove');
    assert.equal(f.management.detail(saved.body.serviceId).service.removed, true);
    assert.equal(f.management.list().services.some(value => value.serviceId === saved.body.serviceId), true);
    await assert.rejects(f.management.state('resurrect', saved.body.serviceId, 3, 'enable'), /服务已变化/u);
  } finally { await f.dispose(); }
});

test('MCP 用户凭据入口只回账号事实；错误、公开账本与事件不回显秘密', async () => {
  const f = await fixture();
  try {
    const preview = f.management.preview({ commandId: 'http-preview', source: '显式配置', config: JSON.stringify({ name: '远程服务', transport: { kind: 'streamable-http', url: 'https://fixture.test/mcp' } }) });
    const service = await f.management.confirm('http-confirm', preview[0]!.previewId);
    const created = await f.request<McpAccount>('/account-create', { commandId: 'bearer-account', serviceId: service.serviceId, revision: 1, label: '私有账号', auth: 'bearer' });
    const configured = await f.request<McpAccount>('/account-configure', { commandId: 'configure', accountId: created.body.accountId, revision: 1, bearer: 'private-token-value', environment: {} });
    assert.equal(configured.status, 200); assert.equal(configured.body.state, 'ready');
    const detail = await f.request(`/detail?serviceId=${service.serviceId}`);
    const publicData = JSON.stringify([configured.body, detail.body, f.events, f.db.prepare('SELECT * FROM mcp_fact').all(), f.db.prepare('SELECT * FROM mcp_command').all()]);
    assert.equal(publicData.includes('private-token-value'), false);
    assert.equal([...f.values.values()].some(value => value.bearer === 'private-token-value'), true);
    const enabled = await f.management.state('enable-http', service.serviceId, 1, 'enable');
    const factory = mcpWireFactory(f.host, f.accounts, [], f.repository);
    await assert.rejects(factory.assertCatalog!(enabled, configured.body, { ...f.catalog, tools: [{ ...f.tool, description: '回显 private-token-value' }] }), /目录包含私有凭据/u);
    const callback = await f.request('/oauth/callback?code=secret-code&state=invalid-secret-state');
    assert.equal(callback.status, 409); assert.equal(callback.raw.includes('secret-code'), false); assert.equal(callback.raw.includes('invalid-secret-state'), false);
    const bad = await f.request('/account-configure', { commandId: 'bad', accountId: created.body.accountId, revision: 3, bearer: 'private-token-value', environment: {}, approved: true });
    assert.equal(bad.status, 400);
  } finally { await f.dispose(); }
});

test('MCP 连接预览绑定规则和执行目录；旧停用回执不会关闭之后重新建立的连接', async () => {
  const f = await fixture();
  try {
    await f.management.state('disable', 'service', 1, 'disable');
    await f.management.state('enable', 'service', 2, 'enable');
    const evidence = f.management.connectionPreview('service', 'account', 'session');
    f.state.directory = '/changed-workspace';
    await assert.rejects(f.management.connect({ commandId: 'changed-directory', serviceId: 'service', accountId: 'account', sessionId: 'session', fingerprint: evidence.fingerprint }), /预览已变化/u);
    f.state.directory = '/workspace';
    const fresh = f.management.connectionPreview('service', 'account', 'session');
    const connected = await f.management.connect({ commandId: 'connect', serviceId: 'service', accountId: 'account', sessionId: 'session', fingerprint: fresh.fingerprint });
    assert.equal(connected.connection?.state, 'connected');
    const opened = f.state.opened;
    await f.management.connect({ commandId: 'connect', serviceId: 'service', accountId: 'account', sessionId: 'session', fingerprint: fresh.fingerprint });
    assert.equal(f.state.opened, opened);
    await f.management.state('disable', 'service', 1, 'disable');
    assert.equal(f.connections.get(connected.connection!.connectionId, 'session').connection.state, 'connected');
    f.context.projectId = 'project';
    f.management.rules.set('exclude', 'service', 0, { kind: 'project', projectId: 'project', excluded: true, accountId: 'account' });
    assert.equal(f.management.availability('service', 'session').available, false);
    assert.equal(f.management.scope('project', 'project')[0]?.rule?.target.kind, 'project');
    assert.equal(f.management.scope('session', 'archived')[0]?.editable, false);
    assert.throws(() => f.management.rules.set('archived-write', 'service', 0, { kind: 'session', sessionId: 'archived', disabled: true }), /归属不可修改/u);
  } finally { await f.dispose(); }
});

test('MCP 建连过程中停止须等待真实结束；重启后缺少停止证据的连接保留门禁', async () => {
  const f = await fixture();
  try {
    const other = new McpConnections(f.repository, { async open() { throw Error('不应重新启动'); } });
    assert.equal(other.stopped('session'), false);
    await assert.rejects(other.closeSession('session'), /未证明关闭/u);
    await assert.rejects(other.connect('service', 'account', { sessionId: 'session', host: 'work' }), /尚未证明停止/u);
    await f.connections.closeSession('session');
    assert.equal(other.stopped('session'), true);
    let release!: () => void, opened = 0, sends = 0, stopped = false;
    const delayed = new McpConnections(f.repository, { async open() { opened++; await new Promise<void>(resolve => { release = resolve; }); return { async start() {}, async send() { sends++; }, async close() {} }; } });
    const connecting = delayed.connect('service', 'account', { sessionId: 'connecting-session', host: 'work' }).catch(error => error);
    await until(() => opened === 1);
    const closing = delayed.closeSession('connecting-session').then(() => { stopped = true; });
    await until(() => !delayed.stopped('connecting-session'));
    assert.equal(stopped, false); assert.equal(sends, 0);
    release(); await connecting; await closing;
    assert.equal(stopped, true); assert.equal(sends, 0); assert.equal(delayed.stopped('connecting-session'), true);
  } finally { await f.dispose(); }
});
