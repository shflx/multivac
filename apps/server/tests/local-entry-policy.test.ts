import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { LocalEntryPolicy, localEntries } from '../src/adapters/http/local-entry-policy.js';
import { RemoteAccess } from '../src/adapters/http/remote-access.js';

function request(host = 'localhost:4317', origin: string | undefined = 'http://localhost:4317', peer = '127.0.0.1', localPort = 4317): IncomingMessage {
  return { headers: { host, ...(origin === undefined ? {} : { origin }) }, socket: { remoteAddress: peer, localPort }, method: 'GET' } as IncomingMessage;
}
const remoteConfig = { enabled: true, token: 'a'.repeat(32), origin: '', host: '0.0.0.0' };

test('本机来源：完整协议/主机/端口必须匹配，生产不放行任意localhost端口', () => {
  const policy = new LocalEntryPolicy(localEntries('production', 4317));
  const access = new RemoteAccess(remoteConfig, Date.now, 'multivac_remote', policy);
  try {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(access.identify(request(`${host}:4317`, `http://${host}:4317`))?.kind, 'local');
    for (const origin of ['http://localhost:4318', 'http://localhost:5173', 'https://localhost:4317', 'http://127.0.0.1:4317', 'http://localhost:4317/', 'null', 'http://localhost:4317@evil.example', 'http://localhost.:4317']) {
      assert.equal(access.identify(request('localhost:4317', origin)), null, origin);
    }
    for (const host of ['localhost:12345', 'localhost:4317/path', 'user@localhost:4317', 'localhost:4317?x', 'localhost:4317#x', 'localhost.:4317', 'localhost:04317', 'localhost:4317:4317']) assert.equal(access.identify(request(host)), null, host);
    assert.equal(access.identify(request('localhost:4317', 'http://localhost:4317', '192.168.1.2')), null);
    assert.equal(access.identify(request('localhost:4317', 'http://localhost:4317', '::ffff:192.168.1.2')), null);
    for (const name of ['Host', 'Origin']) {
      const duplicate = request(); duplicate.rawHeaders = [name, 'localhost:4317', name, 'evil.example'];
      assert.equal(access.identify(duplicate), null);
    }
    const spoofed = request('evil.example', 'http://localhost:4317', '192.168.1.2');
    spoofed.headers['x-forwarded-for'] = '127.0.0.1'; spoofed.headers['x-forwarded-host'] = 'localhost:4317'; spoofed.headers['x-forwarded-proto'] = 'http';
    assert.equal(access.identify(spoofed), null);
  } finally { access.close(); }
});

test('本机来源：开发明确登记Vite代理，同源导航与默认HTTP端口保持兼容', () => {
  const production = new LocalEntryPolicy(localEntries('production', 4317));
  const development = new LocalEntryPolicy(localEntries('development', 4318));
  const proxied = request('127.0.0.1:5173', 'http://127.0.0.1:5173', '127.0.0.1', 4318);
  assert.equal(production.allows(proxied), false);
  assert.equal(development.allows(proxied, true), true);
  assert.equal(development.allows(request('localhost:5174', 'http://localhost:5174', '127.0.0.1', 4318)), false);
  assert.equal(development.allows(request('localhost:4318', 'http://localhost:5173', '127.0.0.1', 4318)), false);
  const navigation = request(); delete navigation.headers.origin;
  assert.equal(production.allows(navigation), true);
  assert.equal(production.allows(navigation, true), false);
  assert.equal(production.allows(request('localhost:80', 'http://localhost', '127.0.0.1', 80), true), true);
  assert.equal(production.allows(request('localhost', 'http://localhost', '127.0.0.1', 80), true), true);
  assert.throws(() => new LocalEntryPolicy([{ hostOrigin: 'http://evil.example', browserOrigin: 'http://evil.example' }]));
});

test('本机来源：实际监听器允许动态端口，Cookie身份与伪造协议不提升本机身份', () => {
  const access = new RemoteAccess(remoteConfig);
  try {
    assert.equal(access.identify(request('localhost:54321', 'http://localhost:54321', '::1', 54321))?.kind, 'local');
    assert.equal(access.identify(request('localhost:54322', 'http://localhost:54322', '::1', 54321)), null);
    const cookie = request(); cookie.headers.cookie = 'multivac_remote=invalid';
    assert.equal(access.identify(cookie), null);
    const encrypted = request(); Object.assign(encrypted.socket, { encrypted: true });
    assert.equal(access.identify(encrypted), null);
    const tlsSpoof = request(); tlsSpoof.headers.origin = 'https://localhost:4317'; tlsSpoof.headers['x-forwarded-proto'] = 'https';
    assert.equal(access.identify(tlsSpoof), null);
  } finally { access.close(); }
});
