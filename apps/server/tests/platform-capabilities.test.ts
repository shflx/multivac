import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformCapabilities, type PlatformCapability } from '../src/runtime/platform-capabilities.js';
const capabilities: PlatformCapability[] = ['startup', 'taskExecution', 'gitPublish', 'terminal', 'mcpStdio', 'taskTools', 'command', 'managedProcess', 'controlledGit', 'skillRun', 'skillCopy', 'reveal', 'open', 'trash', 'remote'];
test('Windows x64 已验收能力开放，系统文件操作继续拒绝', () => {
  const platform = { platform: 'win32' as const, arch: 'x64' };
  const enabled: PlatformCapability[] = ['startup', 'command', 'remote', 'taskExecution', 'mcpStdio', 'terminal',
    'taskTools', 'skillRun', 'skillCopy', 'gitPublish', 'controlledGit', 'managedProcess'];
  for (const key of enabled) assert.equal(createPlatformCapabilities(platform).denial(key), null, key);
  assert.match(createPlatformCapabilities(platform).denial('reveal')!, /仅支持本机 macOS Finder/);
  assert.match(createPlatformCapabilities(platform).denial('open')!, /仅支持本机 macOS/);
  assert.match(createPlatformCapabilities(platform).denial('trash')!, /Windows 的回收站暂不支持/);
  for (const key of enabled)
    assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial(key)!, /实机验证/);
});
test('保留 macOS 及其他既有平台的能力与原拒绝原因', () => {
  const mac = createPlatformCapabilities({ platform: 'darwin', arch: 'arm64' });
  for (const key of capabilities) assert.equal(mac.denial(key), null);
  assert.equal(createPlatformCapabilities({ platform: 'darwin', arch: 'x64' }).denial('terminal'), '项目终端仅支持 macOS arm64 或 Windows 11 x64 本机桌面。');
  const linux = createPlatformCapabilities({ platform: 'linux', arch: 'x64' });
  assert.equal(linux.denial('command'), null);
  assert.equal(linux.denial('mcpStdio'), null);
  assert.equal(linux.denial('controlledGit'), '当前平台尚未验证受控 Git 隔离，未执行。');
});
