import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, type Duplex } from 'node:stream';
import { LocalEntryPolicy, localEntries } from '../src/adapters/http/local-entry-policy.js';
import { RemoteAccess } from '../src/adapters/http/remote-access.js';
import { markRemoteRequest } from '../src/adapters/http/remote-policy.js';
import { guardTerminalHttp, guardTerminalUpgrade, terminalEntryDenial } from '../src/adapters/http/terminal-entry.js';
import { createMultivacHttpServer, type MultivacHttpServerOptions } from '../src/bootstrap/server.js';

const config = { enabled: true, token: 'fixture-token-with-at-least-32-bytes', origin: '', host: '0.0.0.0' };
function local(): IncomingMessage {
  return { url: '/api/terminals/secret/get', method: 'POST', headers: { host: 'localhost:4317', origin: 'http://localhost:4317', 'user-agent': 'Desktop' }, socket: { remoteAddress: '127.0.0.1', localPort: 4317 } } as IncomingMessage;
}
function response() {
  const state = { status: 0, headers: {} as Record<string, string | string[]>, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) { state.status = status; Object.assign(state.headers, headers); return this; },
    setHeader(name: string, value: string | string[]) { state.headers[name] = value; return this; },
    end(body = '') { state.body = body; return this; },
  } as unknown as ServerResponse;
  return { res, state };
}

function rejectedRequests(): IncomingMessage[] {
  const missing = local(); delete missing.headers.origin;
  const wrongPort = local(); wrongPort.headers.origin = 'http://localhost:9999';
  const wrongHost = local(); wrongHost.headers.host = 'localhost:9999';
  const remotePeer = local(); Object.assign(remotePeer.socket, { remoteAddress: '192.168.1.5' });
  const fakeForwarded = local(); Object.assign(fakeForwarded.socket, { remoteAddress: '192.168.1.5' }); fakeForwarded.headers['x-forwarded-for'] = '127.0.0.1';
  const wrongProtocol = local(); wrongProtocol.headers.origin = 'https://localhost:4317';
  const cookie = local(); cookie.headers.cookie = 'multivac_remote=' + 'a'.repeat(43);
  const marked = local(); markRemoteRequest(marked);
  const mobile = local(); mobile.headers['user-agent'] = 'iPhone Mobile';
  const hint = local(); hint.headers['sec-ch-ua-mobile'] = '?1';
  return [missing, wrongPort, wrongHost, remotePeer, fakeForwarded, wrongProtocol, cookie, marked, mobile, hint];
}

test('终端守卫：HTTP与upgrade在下游读取/创建/附着前拒绝非法来源', () => {
  const access = new RemoteAccess(config, Date.now, 'multivac_remote', new LocalEntryPolicy(localEntries('production', 4317)));
  let reads = 0; let attachments = 0;
  try {
    for (const req of rejectedRequests()) {
      const { res, state } = response();
      if (guardTerminalHttp(req, res, access)) reads++;
      assert.equal(state.status, 403); assert.equal(state.body.includes('secret'), false);
      let written = '';
      const socket = { end(value: string) { written += value; } } as unknown as Duplex;
      if (guardTerminalUpgrade(req, socket, access)) attachments++;
      assert.match(written, /^HTTP\/1\.1 403 Forbidden\r\n/u);
    }
    assert.equal(reads, 0); assert.equal(attachments, 0);
    assert.equal(terminalEntryDenial(local(), access, { platform: 'darwin', arch: 'arm64' }), null);
    for (const platform of [{ platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }] as const) assert.match(terminalEntryDenial(local(), access, platform)!, /macOS arm64/u);
  } finally { access.close(); }
});

test('终端守卫：真实RemoteAccess登录状态也不能访问终端', async () => {
  const access = new RemoteAccess(config);
  try {
    const login = Object.assign(Readable.from([Buffer.from(JSON.stringify({ token: config.token }))]), {
      url: '/api/access/login', method: 'POST', headers: { host: 'remote.example', origin: 'http://remote.example', 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.1.5', localPort: 4317 },
    }) as unknown as IncomingMessage;
    const loginResponse = response();
    const identity = access.identify(login)!;
    assert.equal(identity.kind, 'remote');
    await access.handle(login, loginResponse.res, identity);
    assert.equal(loginResponse.state.status, 200);
    const cookie = String(loginResponse.state.headers['set-cookie']).split(';')[0]!;
    const req = local(); Object.assign(req.headers, { host: 'remote.example', origin: 'http://remote.example', cookie });
    Object.assign(req.socket, { remoteAddress: '192.168.1.5' });
    assert.equal(access.identify(req)?.authenticated, true);
    assert.match(terminalEntryDenial(req, access)!, /本机桌面来源/u);
  } finally { access.close(); }
});

test('终端守卫：HTTP factory的实际分发顺序在任何路由前拒绝，无网络监听', async () => {
  const access = new RemoteAccess(config);
  let downstreamCalls = 0;
  const server = createMultivacHttpServer({ remoteAccess: access, testRequestHandler: async (_request: IncomingMessage, res: ServerResponse) => {
    downstreamCalls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return true;
  } } as unknown as MultivacHttpServerOptions);
  try {
    for (const req of rejectedRequests()) {
      const { res, state } = response();
      server.emit('request', req, res);
      assert.equal(state.status, 403);
    }
    assert.equal(downstreamCalls, 0);
    const malformed = local(); malformed.url = 'http://[';
    const invalid = response(); server.emit('request', malformed, invalid.res);
    assert.equal(invalid.state.status, 400); assert.equal(downstreamCalls, 0);
    const valid = response(); server.emit('request', local(), valid.res);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(downstreamCalls, 1); assert.equal(valid.state.status, 200);
  } finally { access.close(); }
});
