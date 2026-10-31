import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalLoopbackPeer, listenerHttpUrl } from '../src/adapters/http/loopback-peer.js';
import { remoteConfigFromEnvironment } from '../src/adapters/http/remote-access.js';
import { remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';

test('IPv4、IPv6 和映射回环仅规范化原有同一对端，不接受转发头或远程地址', () => {
  for (const address of ['127.0.0.1', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1']) assert.equal(isLocalLoopbackPeer(address), true, address);
  for (const address of ['100.64.0.1', '192.168.1.1', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1', 'localhost', '127.0.0.2', '::1%lo']) assert.equal(isLocalLoopbackPeer(address), false, address);
  assert.equal(listenerHttpUrl('::1', 4317), 'http://[::1]:4317');
});
test('Windows 远程默认关闭，显式开启在生成 token 前被门禁拒绝；凭据失败不轮换', () => {
  let generated = 0;
  const token = () => { generated++; return 'a'.repeat(64); };
  assert.equal(remoteConfigFromEnvironment({}, token, 'win32').enabled, false);
  assert.throws(() => remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1' }, token, 'win32'), /实机验证/);
  assert.equal(generated, 0);
  assert.throws(() => remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1' }, () => { throw new Error('ACL failed'); }, 'darwin'), /ACL failed/);
  assert.throws(() => remoteConfigFromEnvironment({ MULTIVAC_REMOTE_ENABLED: '1', MULTIVAC_REMOTE_ORIGIN: 'http://[::ffff:7f00:1]:4317' }, token, 'darwin'), /远程 origin/);
  assert.equal(remoteRouteAllowed('GET', '/api/terminals'), false);
  assert.equal(remoteRouteAllowed('GET', '/api/inbox'), true);
});
