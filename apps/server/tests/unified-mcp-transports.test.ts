import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { McpService } from '@multivac/contracts';
import { McpConnections } from '../src/modules/mcp/connections.js';
import { mcpFingerprint } from '../src/modules/mcp/mcp.js';
import { mcpWireFactory } from '../src/runtime/executors/mcp-wire-factory.js';
import { McpExecutionService, type McpExecutionHost } from '../src/application/mcp-execution-service.js';
import { mcpFixture, mcpTemporaryDirectory } from './fixtures/mcp-fixture.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('受控 MCP 未达到预期状态。');
}

for (const transport of ['stdio', 'http'] as const) test(`两类会话共用真实 MCP ${transport}：子进程/网络、真实许可、取消及版本核对`, { timeout: 30_000 }, async t => {
  const f = mcpFixture();
  const root = realpathSync(mcpTemporaryDirectory('unified-'));
  const work = join(root, 'work'); await mkdir(work);
  let calls = 0;
  const server = createServer((request, response) => {
    if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
    if (request.url === '/probe') { response.end('network-ready'); return; }
    const chunks: Buffer[] = [];
    request.on('data', data => chunks.push(Buffer.from(data)));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString());
      if (!message.id) { response.writeHead(202).end(); return; }
      if (message.method === 'tools/call') calls++;
      const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: {} }
        : message.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'http-actual-result' }] };
      response.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': 'controlled-session' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(join(work, 'service.cjs'), `
const fs=require('node:fs');
if(process.env.OPENAI_API_KEY || process.env.MULTIVAC_DATA_DIR) process.exit(44);
const worker=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('worker.pid',String(worker.pid));
const input=require('node:readline').createInterface({input:process.stdin});
input.on('line',async line=>{
 const m=JSON.parse(line);if(!m.id)return;
 if(m.method==='tools/call')fs.appendFileSync('calls.txt','called\\n');
 const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{}}
 :m.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object'}}]}
 :{content:[{type:'text',text:await(await fetch(${JSON.stringify(url + '/probe')})).text()}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`);
  await mkdir(join(work, 'node_modules/.bin'), { recursive: true });
  await writeFile(join(work, 'package.json'), JSON.stringify({name:'controlled-mcp',version:'1.0.0'}));
  await writeFile(join(work, 'mcp-launcher'), '#!/bin/sh\nexec '+JSON.stringify(process.execPath)+' service.cjs\n', {mode:0o755});
  await symlink('../../mcp-launcher', join(work, 'node_modules/.bin/unified-mcp'));
  // 真实 npx 启动本地夹具，不下载第三方包，也不采用用户 npm 配置。
  const definition: McpService['transport'] = transport === 'stdio'
    ? { kind: 'stdio', command: 'npx', args: ['--offline', '--no-install', '--cache', join(root, 'cache'), '--userconfig', '/dev/null', 'unified-mcp'], cwd: null, environmentKeys: [] }
    : { kind: 'streamable-http', url: url + '/mcp' };
  const service = { ...f.service, revision: 2, transport: definition, configVersion: mcpFingerprint(definition) };
  f.repository.commit('transport', mcpFingerprint(service), new Date().toISOString(), tx => tx.put('service', service, 1));
  const pending = new Set<string>(); let bytes = 0, stopped = false;
  const host: McpExecutionHost = {
    context: sessionId => {
      if (stopped) throw new Error('原 Run 已停止。');
      return { sessionId, projectId: null, agentId: null, taskId: sessionId === 'task' ? 'task-id' : null, runId: sessionId === 'task' ? 'run-id' : null,
        host: sessionId === 'task' ? 'task' : 'work', accountId: 'account', hostEffects: ['read', 'local-write', 'external-write', 'data-transfer'], transportAllowed: true, workingDirectory: work };
    }, transport: () => true,
    lease: (_id, phase, marker, size) => { bytes += size; if (phase === 'starting') pending.add(marker); if (phase === 'settled') pending.delete(marker); return 2_000_000 - bytes; },
    redactor: async () => value => value,
  };
  const accounts = { credentials: async () => ({ environment: {}, headers: {} }), assertCurrent: (_service: string, revision: number, _account: string, accountRevision: number) => {
    assert.equal(f.repository.get('service', 'service')!.revision, revision); assert.equal(f.repository.get('account', 'account')!.revision, accountRevision);
  } };
  const connections = new McpConnections(f.repository, mcpWireFactory(host, accounts, [], f.repository));
  const execution = new McpExecutionService(f.repository, connections, host);
  try {
    for (const session of ['work', 'task']) {
      t.diagnostic(`${session}: connecting`);
      const live = await connections.connect('service', 'account', { sessionId: session, host: session === 'task' ? 'task' : 'work' });
      t.diagnostic(`${session}: connected`);
      const tool = live.catalog.tools[0]!;
      const identity = execution.userIdentity(session, live.connection.connectionId, tool.toolId);
      execution.authorizations.confirmClassification(`classify-${session}`, identity, transport === 'http' ? ['read', 'data-transfer'] : ['read']);
      execution.prepare(session, 'turn');
      const capability = execution.list(session, 'turn')[0]!; assert.ok(capability);
      const invoking = execution.invoke(session, 'turn', `allowed-${session}`, capability.capabilityId, {}, new AbortController().signal);
      await until(() => execution.authorizations.all().some(value => value.identity.toolCallId === `allowed-${session}`));
      const authorization = execution.authorizations.all().find(value => value.identity.toolCallId === `allowed-${session}`)!;
      await execution.authorizations.decide(authorization.requestId, authorization.revision, 'once', `user-${session}`);
      t.diagnostic(`${session}: allowed`);
      const result = await invoking; assert.equal(result.state, 'succeeded'); assert.match(result.resultText!, /network-ready|http-actual-result/);
      await execution.invoke(session, 'turn', `allowed-${session}`, capability.capabilityId, {}, new AbortController().signal);
      const controller = new AbortController();
      const denied = execution.invoke(session, 'turn', `cancel-${session}`, capability.capabilityId, {}, controller.signal);
      await until(() => execution.authorizations.all().some(value => value.identity.toolCallId === `cancel-${session}`));
      controller.abort(); await assert.rejects(denied);
      assert.equal(f.repository.get('call', mcpFingerprint([session, `cancel-${session}`]))!.state, 'cancelled');
      const late = execution.authorizations.all().find(value => value.identity.toolCallId === `cancel-${session}`)!;
      await assert.rejects(execution.authorizations.decide(late.requestId, late.revision, 'once', 'late'));
      t.diagnostic(`${session}: closing`);
      await connections.close(live.connection.connectionId);
      t.diagnostic(`${session}: closed`);
      assert.ok(f.repository.get('connection', live.connection.connectionId)!.localStopConfirmedAt);
      if (transport === 'stdio') { const pid = Number(await readFile(join(work, 'worker.pid'), 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }
    }
    assert.equal(transport === 'http' ? calls : (await readFile(join(work, 'calls.txt'), 'utf8')).trim().split('\n').length, 2);
    assert.equal(pending.size, 0); assert.ok(bytes > 0);
    stopped = true;
    await assert.rejects(connections.connect('service', 'account', { sessionId: 'task', host: 'task' }));
  } finally {
    await execution.close(); f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
