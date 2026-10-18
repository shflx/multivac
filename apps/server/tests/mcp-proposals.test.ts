import test from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { McpAccountService } from '../src/application/mcp-account-service.js';
import { McpManagementService } from '../src/application/mcp-management-service.js';
import { createMcpManagementKind } from '../src/application/proposals/mcp-proposals.js';
import { ProposalService } from '../src/application/proposals/proposal-service.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS, WORK_SESSION_TASK_TOOLS } from '../src/application/internal-tools/index.js';
import { MCP_MANAGEMENT_TOOLS } from '../src/application/internal-tools/mcp-management-tools.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { mcpExecutionFixture } from './fixtures/mcp-execution-fixture.js';
import { testToolServices } from './fixtures/tool-services.js';

async function fixture() {
  const f = await mcpExecutionFixture(), store = new SqliteAssistantStore(':memory:');
  const accounts = new McpAccountService(f.repository, { instanceId: 'proposals-test', async read() { return null; }, async modify() { throw Error('不得导入凭据'); } }, { async authorize() { throw Error('不得登录'); }, async request() { throw Error('不得外连'); } }, 'http://127.0.0.1:43123/api/mcp/oauth/callback');
  const management = new McpManagementService(f.repository, accounts, f.mcp, f.host, { validate() {} }, () => {});
  const proposals = new ProposalService({ repository: store.proposals, kinds: [createMcpManagementKind(() => management)] });
  const tools = new InternalToolService({ tools: MCP_MANAGEMENT_TOOLS, services: testToolServices({ mcpManagement: { list: (...args) => management.list(...args), detail: id => management.detail(id), receipt: (session, id) => proposals.list(session).find(item => item.proposalId === id) } }), calls: store.internalToolCalls, currentTurn: () => ({ commandId: 'turn', windowId: null }), proposals });
  const invoke = (name: string, id: string, args: unknown) => tools.invoke({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName: name, toolCallId: id, args }, new AbortController().signal);
  const propose = (id: string, args: unknown) => invoke('propose_mcp_management', id, args);
  const byCall = (id: string) => proposals.list(GLOBAL_ASSISTANT_SESSION_ID).find(item => item.toolCallId === id)!;
  return { ...f, management, proposals, invoke, propose, byCall, async dispose() { store.close(); await f.dispose(); } };
}

test('MCP 对话实际注册与真实确认：查询不探测，提议不启动；取消、响应丢失重放和停用登记分别记账', async () => {
  const f = await fixture();
  try {
    for (const tool of MCP_MANAGEMENT_TOOLS) { assert.ok(MULTIVAC_INTERNAL_TOOLS.some(item => item.name === tool.name)); assert.equal(WORK_SESSION_TASK_TOOLS.some(item => item.name === tool.name), false); }
    const opened = f.state.opened;
    assert.equal((await f.invoke('query_mcp_management', 'query', { serviceId: 'service' })).ok, true);
    assert.equal(f.state.opened, opened);
    const input = { action: 'import', source: '用户明确粘贴', config: JSON.stringify({ mcpServers: { demo: { command: '/fixture/explicit', args: [] } } }) };
    assert.equal((await f.propose('cancel', input)).ok, true);
    await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, f.byCall('cancel').proposalId, 'cancel');
    assert.equal(f.management.list().total, 1); assert.equal(f.state.opened, opened);
    const first = await f.propose('import', input), replay = await f.propose('import', input);
    assert.deepEqual(first, replay); assert.equal(f.management.list().total, 1);
    const pending = f.byCall('import'); assert.equal(pending.status, 'pending');
    const decided = await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, pending.proposalId, 'confirm');
    assert.equal(decided.status, 'executed');
    assert.deepEqual(await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, pending.proposalId, 'confirm'), decided);
    assert.equal(f.management.list().total, 2); assert.equal(f.state.opened, opened);
    assert.equal(f.management.list().services.find(item => item.serviceId !== 'service')?.enabled, false);
    assert.match(decided.outcome!.summary, /停用登记/u);
    const receipt = await f.invoke('query_mcp_management', 'receipt', { proposalId: pending.proposalId });
    assert.equal(receipt.ok, true); assert.match(receipt.ok ? receipt.content : '', /executed/u);
    assert.equal((await f.propose('forged', { ...input, confirmed: true })).ok, false);
  } finally { await f.dispose(); }
});

test('MCP 提议固定版本、账号和真实目录，变化失效；确认连接才启动且不授予工具许可', async () => {
  const f = await fixture();
  try {
    await f.propose('stale', { action: 'state', serviceId: 'service', revision: 1, state: 'disable' });
    await f.management.state('other-change', 'service', 1, 'disable');
    assert.equal((await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, f.byCall('stale').proposalId, 'confirm')).status, 'expired');
    await f.management.state('reenable', 'service', 2, 'enable');
    const connect = { action: 'connect', serviceId: 'service', accountId: 'account', sessionId: 'session' };
    await f.propose('moved', connect); f.state.directory = '/other';
    assert.equal((await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, f.byCall('moved').proposalId, 'confirm')).status, 'expired');
    f.state.directory = '/workspace'; const before = f.state.opened;
    await f.propose('connect', connect); assert.equal(f.state.opened, before);
    assert.equal((await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, f.byCall('connect').proposalId, 'confirm')).status, 'executed');
    assert.equal(f.state.opened, before + 1); assert.equal(f.repository.list('authorization').length, 0);
    await f.propose('scope', { action: 'rule', serviceId: 'service', revision: 0, target: { kind: 'session', sessionId: 'session', disabled: true } });
    assert.equal(f.repository.list('rule').length, 0);
    assert.equal((await f.proposals.decide(GLOBAL_ASSISTANT_SESSION_ID, f.byCall('scope').proposalId, 'confirm')).status, 'executed');
    assert.equal(f.repository.list('rule').length, 1);
  } finally { await f.dispose(); }
});
