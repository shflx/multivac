import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpWire } from '../src/modules/mcp/client.js';
import { until } from './fixtures/mcp-execution-fixture.js';

test('MCP 账号撤销后仅收敛本地连接，不向旧地址发送新凭据，并保留远程关闭未知', async () => {
  let revoked = false;
  const methods: string[] = [];
  const wire = new McpHttpWire('https://fixture.test/mcp', {
    async authorize() { if (revoked) throw Error('账号已撤销'); },
    async credentials() { if (revoked) throw Error('不得取得新凭据'); return { Authorization: 'Bearer fixture-private' }; },
  }, async (_url, input) => { methods.push(input!.method!); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'request', result: {} }), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'remote-session' } }); });
  await wire.start(() => {});
  await wire.send({ jsonrpc: '2.0', id: 'request', method: 'tools/list' });
  revoked = true;
  await wire.close();
  assert.equal(wire.closeError, 'result-unknown');
  assert.deepEqual(methods, ['POST']);
});

test('MCP HTTP 在凭据读取后同步核对，撤销时不发送请求或登记执行开始', async () => {
  let release!: () => void, reading = false, revoked = false, sent = 0, marked = 0;
  const wire = new McpHttpWire('https://fixture.test/mcp', {
    async authorize() {}, async credentials() { reading = true; await new Promise<void>(resolve => { release = resolve; }); return {}; },
    assertCurrent() { if (revoked) throw Error('身份已变化'); },
  }, async () => { sent++; throw Error('不得发送'); });
  await wire.start(() => {});
  const pending = assert.rejects(wire.send({ jsonrpc: '2.0', id: 'call', method: 'tools/call' }, undefined, () => { marked++; }));
  await until(() => reading); revoked = true; release(); await pending;
  assert.equal(sent, 0); assert.equal(marked, 0); await wire.close();
});
