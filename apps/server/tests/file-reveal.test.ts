import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionFilesService } from '../src/application/session-files-service.js';
import { createSessionFilesRequestHandler } from '../src/adapters/http/session-files-routes.js';
import { markRemoteRequest, remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';
import type { RequestAccess } from '../src/adapters/http/remote-access.js';

const local: RequestAccess = { kind: 'local', authenticated: true, loginKey: null };
const browserHeaders = { host: 'localhost:4317', origin: 'http://localhost:4317', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const request = (url: string, headers: Record<string, string> = browserHeaders, address = '127.0.0.1', method = 'POST') => ({ url, method, headers, socket: { remoteAddress: address } }) as IncomingMessage;

async function call(handler: ReturnType<typeof createSessionFilesRequestHandler>, req: IncomingMessage, access?: RequestAccess) {
  let status = 0, body: any;
  const response = { destroyed: false, writableEnded: false, writeHead(value: number) { status = value; }, end(text: string) { body = JSON.parse(text); } } as unknown as ServerResponse;
  assert.equal(await handler(req, response, access), true);
  return { status, body };
}

async function fixture(platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'multivac-reveal-'));
  const file = "中文 空格 '引号 $(x);--.txt";
  await writeFile(join(root, file), '不应执行');
  await mkdir(join(root, '目录 空格.app'));
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const session = { archivedAt: null as string | null, workingDirectory: { kind: 'session-temp' as const, path: root } };
  const service = new SessionFilesService({ get: () => session }, join(root, 'data'), { platform, run: async (executable, args) => { calls.push({ executable, args }); } });
  const handler = createSessionFilesRequestHandler(service);
  const url = (path = file, kind = 'file', expectedRoot = root) => `/api/sessions/work/files/reveal?${new URLSearchParams({ path, root: expectedRoot, kind })}`;
  return { root, file, session, service, handler, calls, url, close: () => rm(root, { recursive: true, force: true }) };
}

test('Finder定位只用固定open与独立参数，文件选中、目录指定Finder且不读取正文', async () => {
  const f = await fixture();
  try {
    f.service.read = async () => { throw new Error('不应读正文'); };
    const file = await call(f.handler, request(f.url()), local);
    assert.equal(file.status, 200); assert.match(file.body.message, /命令已退出/);
    assert.deepEqual(f.calls[0], { executable: '/usr/bin/open', args: ['-R', join(f.root, f.file)] });
    assert.equal((await call(f.handler, request(f.url('目录 空格.app', 'directory')), local)).status, 200);
    assert.deepEqual(f.calls[1], { executable: '/usr/bin/open', args: ['-a', '/System/Library/CoreServices/Finder.app', join(f.root, '目录 空格.app')] });
  } finally { await f.close(); }
});

test('远程、缺少用户上下文、伪造正文、跨源及非浏览器请求在目标及启动器前拒绝', async () => {
  const f = await fixture();
  try {
    f.service.target = async () => { throw new Error('非法请求不得进入路径服务'); };
    const remote = { kind: 'remote' as const, authenticated: true, loginKey: 'login' };
    const marked = request(f.url()); markRemoteRequest(marked);
    for (const [req, access] of [
      [request(f.url()), undefined], [request(f.url()), remote], [marked, local],
      [request(f.url(), browserHeaders, '192.168.1.2'), local],
      [request(f.url(), { host: 'localhost:4317', 'x-user-click': 'true' }), local],
      [request(f.url(), { ...browserHeaders, origin: 'https://remote.example' }), local],
      [request(f.url(), { ...browserHeaders, 'sec-fetch-site': 'cross-site' }), local],
      [request(f.url(), { ...browserHeaders, 'sec-fetch-dest': 'document' }), local],
    ] as Array<[IncomingMessage, RequestAccess | undefined]>) assert.equal((await call(f.handler, req, access)).status, 403);
    assert.equal((await call(f.handler, request(f.url(), browserHeaders, '127.0.0.1', 'GET'), local)).status, 405);
    assert.equal(remoteRouteAllowed('POST', '/api/sessions/work/files/reveal'), false);
    assert.equal(remoteRouteAllowed('POST', '/api/sessions/global-coordinator/files/reveal'), false);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('越界、失效、类型变化、目录变化及链接在启动系统程序前拒绝', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.root, f.file), join(f.root, 'link'));
    await mkdir(join(f.root, 'data'));
    await writeFile(join(f.root, 'data', 'private'), '内部资料');
    for (const url of [f.url('../outside'), f.url('/outside'), f.url('missing'), f.url('link'), f.url(f.file, 'directory'), f.url(f.file, 'file', '/old-root'), f.url('data/private'), f.url(f.file, 'unknown')]) {
      const result = await call(f.handler, request(url), local);
      assert.ok(result.status >= 400, url);
    }
    f.session.archivedAt = '2026-10-20';
    assert.equal((await call(f.handler, request(f.url()), local)).status, 404);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('非macOS明确不支持，启动异常如实反馈，准备期间会话变化拒绝', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const f = await fixture(platform);
    try {
      const result = await call(f.handler, request(f.url()), local);
      assert.equal(result.status, 400); assert.match(result.body.error.message, /当前平台不支持/); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const failing = new SessionFilesService({ get: () => f.session }, join(f.root, 'data'), { platform: 'darwin', run: async () => { throw new Error('spawn ENOENT'); } });
    const result = await call(createSessionFilesRequestHandler(failing), request(f.url()), local);
    assert.equal(result.status, 502); assert.match(result.body.error.message, /失败或超时/);
    const target = f.service.target.bind(f.service);
    let checks = 0;
    f.service.target = async (...args) => { const value = await target(...args); if (++checks === 2) f.session.archivedAt = '2026-10-20'; return value; };
    assert.equal((await call(f.handler, request(f.url()), local)).status, 409);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
