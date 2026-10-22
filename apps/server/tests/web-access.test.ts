import { createWebProvider } from '../src/bootstrap/web-provider.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekWebProvider } from '../src/adapters/web/deepseek-web-provider.js';
import { WebAccessService, publicWebUrl } from '../src/application/web-access-service.js';
import { WEB_TOOLS } from '../src/application/internal-tools/web-tools.js';
import { InternalToolService } from '../src/application/internal-tools/internal-tool-service.js';
import type { InternalToolCallRepository } from '../src/modules/internal-tools/internal-tool.js';
import type { WebProvider, WebRequestContext } from '../src/modules/web/web-provider.js';
import { testToolServices } from './fixtures/tool-services.js';

const signal = () => new AbortController().signal;
const context = (): WebRequestContext => ({ signal: signal(), maxBytes: 10000, received: () => {} });
const host = () => {
  const calls: Array<{ phase: string; marker: string; bytes: number }> = [];
  return { calls, lease: (_id: string, phase: 'starting' | 'settled', marker: string, bytes: number) => {
    calls.push({ phase, marker, bytes }); return 512 * 1024;
  }, remainingMillis: () => 30000 };
};
const provider = (request: typeof globalThis.fetch) => new DeepSeekWebProvider('private-test-key', request);
const hit = { title: '文档', url: 'https://example.com/doc', summary: '摘要', date: null };

test('DeepSeek：固定端点、认证、禁止重定向、请求格式与规范化结果', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const backend = provider(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json(String(url).endsWith('/search') ? { results: [hit] } : { title: '文档', content: '# 正文' });
  });
  assert.deepEqual(await backend.search({ query: '测试', count: 3 }, context()), [
    { title: '文档', url: hit.url, summary: '摘要', publishedAt: null },
  ]);
  assert.deepEqual(await backend.fetch(hit.url, context()), { title: '文档', content: '# 正文', url: hit.url });
  assert.equal(requests[0]!.url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(requests[1]!.url, 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(requests[0]!.init.redirect, 'error');
  assert.equal(new Headers(requests[0]!.init.headers).get('authorization'), 'Bearer private-test-key');
  assert.deepEqual(JSON.parse(requests[0]!.init.body as string), { query: '测试', count: 3, need_content: false });
  assert.deepEqual(JSON.parse(requests[1]!.init.body as string), { url: hit.url });
});

test('配置：默认关闭、显式认证、不借用模型密钥、不接受未知供应商', () => {
  assert.equal(createWebProvider({ DEEPSEEK_API_KEY: 'model-key' }), undefined);
  assert.throws(() => createWebProvider({ MULTIVAC_WEB_PROVIDER: 'other' }), /仅支持/u);
  assert.throws(() => createWebProvider({ MULTIVAC_WEB_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'model-key' }), /MULTIVAC_WEB_API_KEY/u);
  assert.equal(createWebProvider({ MULTIVAC_WEB_PROVIDER: 'deepseek', MULTIVAC_WEB_API_KEY: 'key' })!.id, 'deepseek');
});

test('URL：拒绝本机、内网字面量、凭据、危险协议与端口，规范化公开 URL', () => {
  for (const url of ['file:///etc/passwd', 'http://localhost/a', 'http://127.1', 'http://2130706433',
    'http://10.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://host.internal',
    'https://u:p@example.com', 'https://example.com:8080', 'http://localhost./']) {
    assert.throws(() => publicWebUrl(url), /公开网页|HTTP/u, url);
  }
  assert.equal(publicWebUrl('https://example.com/doc#part'), hit.url);
});

test('搜索校验与 Unicode 限制在请求前完成；空结果是成功', async () => {
  let count = 0;
  const backend = provider(async () => { count++; return Response.json({ results: [] }); });
  const service = new WebAccessService(backend, host());
  assert.throws(() => service.search('s', { query: ' ' }, signal()), /不能为空/u);
  assert.throws(() => service.search('s', { query: 'a', count: 11 }, signal()), /1 至 10/u);
  await assert.rejects(service.search('s', { query: '😀'.repeat(129) }, signal()), /128/u);
  assert.equal(count, 0);
  assert.deepEqual((JSON.parse(await service.search('s', { query: '😀'.repeat(128) }, signal()))).results, []);
  assert.equal(count, 1);
});

test('HTTP 失败、畸形响应不泄露原始响应或请求密钥', async () => {
  for (const status of [401, 402, 403, 404, 429, 500]) {
    const backend = provider(async () => new Response('private-test-key raw-secret', { status }));
    await assert.rejects(backend.fetch(hit.url, context()), error => {
      assert.doesNotMatch(String(error), /private-test-key|raw-secret/u); return true;
    });
  }
  for (const body of ['not JSON private-test-key', '{}', '{"results":[{}]}']) {
    await assert.rejects(provider(async () => new Response(body)).search({ query: 'a', count: 5 }, context()), /响应|数据/u);
  }
  await assert.rejects(provider(async () => { throw new Error('private-test-key'); }).fetch(hit.url, context()), /连接失败/u);
});

test('输出截断有标记，线上的响应字节按租约结算', async () => {
  const budget = host();
  const raw = { title: '标题', content: '文'.repeat(25000) };
  const service = new WebAccessService(provider(async () => Response.json(raw)), budget);
  const result = JSON.parse(await service.fetch('s', { url: hit.url }, signal()));
  assert.equal(result.content.length, 24000);
  assert.equal(result.truncated, true);
  assert.equal(budget.calls[1]!.bytes, Buffer.byteLength(JSON.stringify(raw)));
  assert.equal(budget.calls[0]!.marker, budget.calls[1]!.marker);
  assert.equal(service.stopped('s'), true);
});

test('响应超限会停止读取并结算，预算耗尽时不发请求', async () => {
  const budget = host();
  budget.lease = (_id, phase, marker, bytes) => { budget.calls.push({ phase, marker, bytes }); return 8; };
  const service = new WebAccessService(provider(async () => Response.json({ title: '标题', content: '正文' })), budget);
  await assert.rejects(service.fetch('s', { url: hit.url }, signal()), /超过读取上限/u);
  assert.ok(budget.calls[1]!.bytes > 8);
  let called = false;
  const exhausted = new WebAccessService(provider(async () => { called = true; return Response.json({}); }), { lease: () => 0, remainingMillis: () => 0 });
  await assert.rejects(exhausted.fetch('s', { url: hit.url }, signal()), /预算/u);
  assert.equal(called, false);
});

test('取消、超时及服务关闭等待请求结束并释放租约', async () => {
  for (const mode of ['cancel', 'timeout', 'close']) {
    const budget = host();
    if (mode === 'timeout') budget.remainingMillis = () => 5;
    const controller = new AbortController();
    const service = new WebAccessService(provider(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })), budget);
    const pending = service.fetch('s', { url: hit.url }, controller.signal);
    assert.equal(service.stopped('s'), false);
    const rejected = assert.rejects(pending, /取消或超时/u);
    if (mode === 'cancel') controller.abort();
    if (mode === 'close') await service.close();
    await rejected;
    assert.equal(service.stopped('s'), true);
    assert.deepEqual(budget.calls.map(call => call.phase), ['starting', 'settled']);
  }
});

test('取消发生在响应正文读取中时仍终止并结算', async () => {
  const controller = new AbortController();
  const service = new WebAccessService(provider(async (_url, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{'));
      init!.signal!.addEventListener('abort', () => stream.error(new Error('aborted')), { once: true });
    },
  }))), host());
  const pending = service.fetch('s', { url: hit.url }, controller.signal);
  const rejected = assert.rejects(pending, /取消或超时/u);
  setImmediate(() => controller.abort());
  await rejected;
  assert.equal(service.stopped('s'), true);
});

test('替换服务商不改变工具契约；注册表验证参数并只公开摘要', async () => {
  let calls = 0;
  const alternative: WebProvider = { id: 'alternative',
    search: async input => { calls++; assert.equal(input.count, 5); return [{ title: '文档', url: hit.url, summary: '摘要', publishedAt: null }]; },
    fetch: async url => ({ title: '文档', url, content: '正文' }),
  };
  const tools = new InternalToolService({ tools: WEB_TOOLS,
    services: testToolServices({ web: new WebAccessService(alternative, host()) }),
    calls: {} as InternalToolCallRepository, currentTurn: () => null });
  const invoke = (name: string, args: unknown) => tools.invoke({ assistantSessionId: 's', toolName: name, toolCallId: 't', args }, signal());
  assert.equal((await invoke('web_search', { query: 'a', secret: 'x' })).ok, false);
  assert.equal(calls, 0);
  const result = await invoke('web_search', { query: 'a' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.content, /不可信数据/u);
    assert.match(result.content, /alternative/u);
    assert.deepEqual(result.result, { summary: '网页搜索已完成', refs: [] });
  }
  assert.equal((await invoke('web_fetch', { url: hit.url })).ok, true);
});
