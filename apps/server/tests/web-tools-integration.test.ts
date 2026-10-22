import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

function json(port: number, path: string, method = 'GET', body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try { assert.ok(res.statusCode! < 400, Buffer.concat(chunks).toString()); resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('应用装配：配置开关控制全局和工作会话的网页工具，执行记录只有公开回执', async () => {
  for (const enabled of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'multivac-web-tools-'));
    let calls = 0;
    const originalFetch = globalThis.fetch;
    // DeepSeek 适配器在创建时捕获传输；应用本身仍使用真实的注册、SQLite 与 HTTP 路由。
    globalThis.fetch = async url => {
      calls++;
      assert.match(String(url), /^https:\/\/api\.deepseek\.com\/v1\/tools\//u);
      return Response.json(String(url).endsWith('/search') ? { results: [{ title: '示例', url: 'https://example.com', summary: '搜索正文', date: null }] }
        : { title: '示例', content: '读取正文' });
    };
    let app: ReturnType<typeof createMultivacApplication> | undefined;
    try {
      app = createMultivacApplication({ ...testApplicationEnvironment(root), ...(enabled ? {
        MULTIVAC_WEB_PROVIDER: 'deepseek', MULTIVAC_WEB_API_KEY: 'private-integration-key',
      } : {}) });
      globalThis.fetch = originalFetch;
      await app.ready;
      await new Promise<void>(resolve => app!.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const port = address.port;
      await json(port, '/api/sessions', 'POST', { sessionId: 'web-work', title: '网页工作会话' });
      for (const sessionId of [GLOBAL_ASSISTANT_SESSION_ID, 'web-work']) {
        const base = sessionId === GLOBAL_ASSISTANT_SESSION_ID ? '/api/assistant' : `/api/sessions/${sessionId}`;
        for (const [tool, args] of [['web_search', { query: '文档' }], ['web_fetch', { url: 'https://example.com' }]] as const) {
          const commandId = `${sessionId}-${tool}`;
          await json(port, `${base}/turns`, 'POST', { commandId, assistantSessionId: sessionId,
            text: `内部工具：${tool} ${JSON.stringify(args)}`, contextRefs: [] });
          const page = await json(port, `${base}/session`);
          const execution = page.toolExecutions.find((item: any) => item.commandId === commandId);
          assert.equal(execution.status, enabled ? 'succeeded' : 'failed');
          if (enabled) {
            assert.equal(execution.displayName, tool === 'web_search' ? '搜索网页' : '读取网页');
            assert.deepEqual(execution.result.refs, []);
            assert.doesNotMatch(JSON.stringify(execution.result), /搜索正文|读取正文|private-integration-key/u);
            assert.match(page.messages.at(-1).text, /不可信数据/u);
          }
        }
      }
      assert.equal(calls, enabled ? 4 : 0);
    } finally {
      globalThis.fetch = originalFetch;
      app?.server.closeAllConnections();
      app?.server.close();
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
