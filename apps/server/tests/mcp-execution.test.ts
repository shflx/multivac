import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { InternalToolService } from '../src/application/internal-tools/internal-tool-service.js';
import { MCP_EXECUTION_TOOLS } from '../src/application/internal-tools/mcp-tools.js';
import { createPiInternalToolSet } from '../src/runtime/executors/pi-internal-tools.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { McpRuleService } from '../src/modules/mcp/rules.js';
import { McpExecutionService } from '../src/application/mcp-execution-service.js';
import { McpConnections } from '../src/modules/mcp/connections.js';
import { McpError, mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { mcpExecutionFixture, until } from './fixtures/mcp-execution-fixture.js';
import { mcpTemporaryDirectory } from './fixtures/mcp-fixture.js';
import { testToolServices } from './fixtures/tool-services.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

const signal = () => new AbortController().signal;

test('MCP 公共工具经 Pi 工具桥与 Fake harness 注入，原调用等待真实决定且重放不重复执行', async () => {
  const f = await mcpExecutionFixture(), ledger = new SqliteAssistantStore(':memory:');
  const fake = new FakeCoordinatorAdapter({ promptScenario: 'internalTools', promptDelayMs: 0, seedsHistory: () => false });
  try {
    ledger.sessions.insertIfAbsent({ sessionId: 'session', title: 'MCP 工具桥测试', kind: 'work', workspaceId: ledger.sessions.listAll()[0]!.workspaceId,
      createdAt: new Date().toISOString(), workingDirectory: { kind: 'session-temp', path: '/workspace' } });
    f.mcp.prepare('session', 'unclassified'); assert.deepEqual(f.mcp.list('session', 'unclassified'), []);
    f.classify(); f.mcp.prepare('session', 'command');
    const capabilityId = f.mcp.list('session', 'command')[0]!.capabilityId;
    const tools = new InternalToolService({ tools: MCP_EXECUTION_TOOLS, services: testToolServices({ mcp: f.mcp }), calls: ledger.internalToolCalls,
      currentTurn: () => ({ commandId: 'command', windowId: null }) });
    const pi = createPiInternalToolSet('session', tools), call = pi.definitions.find(value => value.name === 'call_mcp_tool')!;
    assert.equal(pi.definitions.length, 2);
    const args = { capabilityId, arguments: { query: '中文参数' } };
    const pending = call.execute('pi-call', args, signal(), undefined, undefined as never);
    await until(() => f.mcp.authorizations.all().length === 1);
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, 0);
    const request = f.mcp.authorizations.all()[0]!;
    assert.deepEqual(request.arguments, args.arguments);
    await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', 'user-allow-pi');
    const result = await pending;
    assert.match(JSON.stringify(result), /实际结果/); assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    await call.execute('pi-call', args, signal(), undefined, undefined as never);
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, 1);
    const ready = await fake.createSession({ assistantSessionId: 'session', workingDirectory: { kind: 'session-temp', path: '/workspace' }, internalTools: tools,
      config: { systemPrompt: '', authorizedContext: [], model: { source: 'base', provider: 'fixture', modelId: 'fixture', thinkingLevel: 'off' }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 } } });
    assert.equal(ready.ok, true);
    const fakePending = fake.prompt('session', `内部工具：call_mcp_tool#fake-call ${JSON.stringify(args)}`);
    await until(() => f.mcp.authorizations.all().length === 2);
    const second = f.mcp.authorizations.all().find(value => value.identity.toolCallId === 'fake-call')!;
    await f.mcp.authorizations.decide(second.requestId, second.revision, 'once', 'user-allow-fake');
    assert.equal((await fakePending).ok, true);
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, 2);
    assert.deepEqual(f.leases, ['starting', 'settled', 'starting', 'settled']);
  } finally { fake.dispose(); ledger.close(); await f.dispose(); }
});

test('MCP 私有读取等待期间规则收紧时，在实际发送前拒绝且保留未开始事实', async () => {
  const f = await mcpExecutionFixture();
  let release: () => void = () => {}, reading = false;
  try {
    f.classify(); f.mcp.prepare('session', 'command');
    f.host.redactor = async () => { reading = true; await new Promise<void>(resolve => { release = resolve; }); return text => text; };
    const capability = f.mcp.list('session', 'command')[0]!;
    const pending = f.mcp.invoke('session', 'command', 'deferred', capability.capabilityId, {}, signal());
    const rejected = assert.rejects(pending, /规则|停用/u);
    await until(() => f.mcp.authorizations.all().length === 1);
    const request = f.mcp.authorizations.all()[0]!;
    await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', 'allow-deferred');
    await until(() => reading);
    new McpRuleService(f.repository, { validate() {} }).set('disable-during-read', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true });
    release(); await rejected;
    assert.equal(f.repository.list('call')[0]!.state, 'cancelled');
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, 0);
    assert.deepEqual(f.leases, []);
  } finally { release(); await f.dispose(); }
});

test('MCP 并发同身份只执行一次，取消等待不调用工具，取消在途保留未知且不重放', async () => {
  const f = await mcpExecutionFixture();
  try {
    f.classify(); f.mcp.prepare('session', 'command'); const capability = f.mcp.list('session', 'command')[0]!.capabilityId;
    const controller = new AbortController();
    const waiting = f.mcp.invoke('session', 'command', 'waiting', capability, {}, controller.signal);
    await until(() => f.mcp.authorizations.all().length === 1); controller.abort();
    await assert.rejects(waiting);
    assert.equal(f.mcp.authorizations.all()[0]!.status, 'cancelled');
    assert.equal(f.repository.get('call', mcpFingerprint(['session', 'waiting']))?.state, 'cancelled');
    assert.equal(f.sent.some(value => value.method === 'tools/call'), false);
    f.state.hang = true;
    const running = f.mcp.invoke('session', 'command', 'running', capability, {}, signal());
    assert.equal(f.mcp.invoke('session', 'command', 'running', capability, {}, signal()), running);
    await assert.rejects(f.mcp.invoke('session', 'command', 'running', capability, { different: true }, signal()), /参数不一致/);
    await until(() => f.mcp.authorizations.all().length === 2);
    const request = f.mcp.authorizations.all().find(value => value.identity.toolCallId === 'running')!;
    await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', 'allow-running');
    await until(() => f.sent.some(value => value.method === 'tools/call'));
    const stopped = f.mcp.cancelSession('session'); await assert.rejects(running); await stopped;
    const call = f.repository.get('call', mcpFingerprint(['session', 'running']))!;
    assert.equal(call.state, 'unknown'); assert.equal(f.mcp.stopped('session'), true);
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, 1);
    assert.equal(call.resultText, null);
  } finally { await f.dispose(); }
});

test('MCP 项目规则、工具定义及目录在许可前变化使本轮失效，不启动新工具操作', async () => {
  for (const change of ['rule', 'tool', 'directory'] as const) {
    const f = await mcpExecutionFixture();
    try {
      f.classify(); f.mcp.prepare('session', 'command'); const capability = f.mcp.list('session', 'command')[0]!.capabilityId;
      const pending = f.mcp.invoke('session', 'command', change, capability, {}, signal());
      await until(() => f.mcp.authorizations.all().length === 1);
      if (change === 'rule') new McpRuleService(f.repository, { validate() {} }).set('disable', 'service', 0, { kind: 'session', sessionId: 'session', disabled: true });
      if (change === 'tool') f.state.changed = true;
      if (change === 'directory') f.state.directory = '/other';
      const request = f.mcp.authorizations.all()[0]!;
      assert.equal((await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', `allow-${change}`)).status, 'invalidated');
      await assert.rejects(pending);
      assert.equal(f.sent.some(value => value.method === 'tools/call'), false);
    } finally { await f.dispose(); }
  }
});

test('MCP 重启将未开始与在途事实分别收敛，已有成功结果和未知结果都不重发', async () => {
  const f = await mcpExecutionFixture();
  try {
    f.classify(); f.mcp.prepare('session', 'command'); const capability = f.mcp.list('session', 'command')[0]!.capabilityId;
    const pending = f.mcp.invoke('session', 'command', 'recover', capability, {}, signal());
    await until(() => f.mcp.authorizations.all().length === 1);
    const request = f.mcp.authorizations.all()[0]!;
    await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', 'allow-recover'); await pending;
    const calls = f.sent.filter(value => value.method === 'tools/call').length;
    assert.equal((await f.mcp.invoke('session', 'command', 'recover', capability, {}, signal())).state, 'succeeded');
    assert.equal(f.sent.filter(value => value.method === 'tools/call').length, calls);
    const previous = f.repository.list('call')[0]!;
    f.repository.commit('interrupted', mcpFingerprint('interrupted'), new Date().toISOString(), tx => {
      const prepared = { ...previous, callId: 'interrupted', revision: 1, identity: { ...previous.identity, toolCallId: 'interrupted' }, state: 'prepared' as const, resultText: null, resultRef: null };
      tx.put('call', prepared, 0); tx.put('call', { ...prepared, revision: 2, state: 'running' }, 1);
    });
    await f.mcp.close();
    const recovered = new McpExecutionService(f.repository, new McpConnections(f.repository, { async open() { throw new Error('不得建连'); } }), f.host);
    recovered.recover(); recovered.recover();
    assert.equal(f.repository.get('call', 'interrupted')?.state, 'unknown');
    assert.equal(f.repository.get('call', previous.callId)?.state, 'succeeded');
  } finally { await f.dispose(); }
});

test('MCP 后台任务从显式项目账号取得本轮本地能力，连接不复用其他会话且宿主拒绝不能覆盖', async () => {
  const f = await mcpExecutionFixture();
  try {
    f.classify(); await f.mcp.close();
    Object.assign(f.context, { host: 'task', projectId: 'project', taskId: 'task', runId: 'run', agentId: 'agent', hostEffects: ['read', 'local-write'] });
    new McpRuleService(f.repository, { validate() {} }).set('project-account', 'service', 0, { kind: 'project', projectId: 'project', excluded: false, accountId: 'account' });
    f.mcp.prepare('session', 'task-command');
    const capability = f.mcp.list('session', 'task-command')[0]!.capabilityId;
    const pending = f.mcp.invoke('session', 'task-command', 'task-call', capability, {}, signal());
    await until(() => f.mcp.authorizations.all().length === 1);
    const request = f.mcp.authorizations.all()[0]!;
    assert.equal(request.identity.runId, 'run'); assert.equal(request.identity.host, 'task');
    await f.mcp.authorizations.decide(request.requestId, request.revision, 'once', 'allow-task');
    assert.equal((await pending).state, 'succeeded'); assert.equal(f.state.opened, 2);
    f.host.transport = () => false;
    f.mcp.prepare('session', 'blocked-command'); assert.deepEqual(f.mcp.list('session', 'blocked-command'), []);
    assert.equal(f.state.opened, 2);
  } finally { await f.dispose(); }
});

test('MCP 候选准入与实际调用分开核对，准备快照不授予任务执行权限', async () => {
  const f = await mcpExecutionFixture();
  try {
    f.classify();
    f.mcp.prepare('session', 'queued-command');
    const capabilityId = f.mcp.list('session', 'queued-command')[0]!.capabilityId;
    f.mcp.finishTurn('session');
    const context = f.host.context;
    f.host.context = (sessionId, commandId, phase) => {
      if (phase !== 'prepare') throw new McpError('rule-denied', '任务尚未运行，不允许实际调用。');
      return context(sessionId, commandId);
    };
    f.mcp.prepare('session', 'queued-command');
    assert.deepEqual(f.mcp.list('session', 'queued-command'), []);
    await assert.rejects(f.mcp.invoke('session', 'queued-command', 'queued-call', capabilityId, {}, signal()), /尚未运行/);
    assert.equal(f.sent.some(message => message.method === 'tools/call'), false);
    assert.equal(f.mcp.authorizations.all().length, 0);
  } finally { await f.dispose(); }
});

test('MCP 生产装配的 Fake 应用可在任务目录内启动和关闭，不启动服务进程或网络监听', async () => {
  const root = mcpTemporaryDirectory('bootstrap-');
  try {
    const { createMultivacApplication } = await import('../src/bootstrap/application.js');
    const app = createMultivacApplication(testApplicationEnvironment(root));
    try {
      await app.ready;
      assert.equal(app.mcp.hasActivity(), false);
      assert.ok(app.mcpAccounts);
      // 未配置 MCP 服务也必须经过真实任务准入、发送及停止流程，不能被候选快照拦截。
      const task = app.tasks.create({ commandId: 'create-task', title: '普通后台任务', goal: '保留原发送流程' }).task;
      await app.taskExecution.control(task.taskId, { commandId: 'start-task', revision: task.revision, action: 'start' });
      await app.taskExecution.idle();
      assert.equal(app.tasks.get(task.taskId).status, 'waiting');
      assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, true);
    }
    finally { await app.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
