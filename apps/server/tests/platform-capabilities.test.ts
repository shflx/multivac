import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformCapabilities, type PlatformCapability } from '../src/runtime/platform-capabilities.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
const capabilities: PlatformCapability[] = ['startup', 'taskExecution', 'gitPublish', 'terminal', 'mcpStdio', 'taskTools', 'command', 'managedProcess', 'controlledGit', 'skillRun', 'skillCopy', 'reveal', 'open', 'trash', 'remote'];
test('Windows 所有能力统一关闭，启动在数据初始化前拒绝', () => {
  const platform = { platform: 'win32' as const, arch: 'x64' };
  for (const key of capabilities) assert.match(createPlatformCapabilities(platform).denial(key)!, /尚待 Windows 11 x64 实机验证/);
  assert.throws(() => createMultivacApplication({}, { platform }), /实机验证/);
});
test('保留 macOS 及其他既有平台的能力与原拒绝原因', () => {
  const mac = createPlatformCapabilities({ platform: 'darwin', arch: 'arm64' });
  for (const key of capabilities) assert.equal(mac.denial(key), null);
  assert.equal(createPlatformCapabilities({ platform: 'darwin', arch: 'x64' }).denial('terminal'), '项目终端仅支持 macOS arm64 本机桌面。');
  const linux = createPlatformCapabilities({ platform: 'linux', arch: 'x64' });
  assert.equal(linux.denial('command'), null);
  assert.equal(linux.denial('mcpStdio'), null);
  assert.equal(linux.denial('controlledGit'), '当前平台尚未验证受控 Git 隔离，未执行。');
});
