import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformCapabilities, type PlatformCapability } from '../src/runtime/platform-capabilities.js';
const capabilities: PlatformCapability[] = ['startup', 'taskExecution', 'gitPublish', 'terminal', 'mcpStdio', 'taskTools', 'command', 'managedProcess', 'controlledGit', 'skillRun', 'skillCopy', 'reveal', 'open', 'trash', 'remote'];
test('Windows x64 启动、命令、远程、任务、MCP stdio 与本机终端已开放，其余能力继续统一拒绝', () => {
  const platform = { platform: 'win32' as const, arch: 'x64' };
  assert.equal(createPlatformCapabilities(platform).denial('startup'), null);
  assert.equal(createPlatformCapabilities(platform).denial('command'), null);
  assert.equal(createPlatformCapabilities(platform).denial('remote'), null);
  assert.equal(createPlatformCapabilities(platform).denial('taskExecution'), null);
  assert.equal(createPlatformCapabilities(platform).denial('mcpStdio'), null);
  assert.equal(createPlatformCapabilities(platform).denial('terminal'), null);
  for (const key of capabilities.filter(key => key !== 'startup' && key !== 'command' && key !== 'remote' && key !== 'taskExecution' && key !== 'mcpStdio' && key !== 'terminal'))
    assert.match(createPlatformCapabilities(platform).denial(key)!, /尚待 Windows 11 x64 实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('startup')!, /实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('command')!, /实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('remote')!, /实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('taskExecution')!, /实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('mcpStdio')!, /实机验证/);
  assert.match(createPlatformCapabilities({ platform: 'win32', arch: 'arm64' }).denial('terminal')!, /实机验证/);
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
