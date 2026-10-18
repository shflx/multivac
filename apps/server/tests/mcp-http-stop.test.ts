import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpWire } from '../src/modules/mcp/client.js';
import { until } from './fixtures/mcp-execution-fixture.js';

test('MCP HTTP 关闭等待本地请求真实收敛，发出 abort 本身不算停止证明', async () => {
  let began = false, release: () => void = () => {}, abortObserved = false, closed = false;
  const request: typeof fetch = async (_url, input) => {
    began = true;
    return new Promise((_resolve, reject) => {
      input?.signal?.addEventListener('abort', () => { abortObserved = true; release = () => reject(new Error('请求已收敛')); }, { once: true });
    });
  };
  const wire = new McpHttpWire('https://fixture.test/mcp', { async authorize() {}, async credentials() { return {}; } }, request);
  await wire.start(() => {});
  const sending = wire.send({ jsonrpc: '2.0', id: 'request', method: 'tools/list' }).catch(() => {});
  await until(() => began);
  const stopping = wire.close().then(() => { closed = true; });
  await until(() => abortObserved);
  assert.equal(closed, false);
  release(); await sending; await stopping;
  assert.equal(closed, true);
});
