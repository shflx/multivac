import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WINDOWS_STDIO_ROOT } from '../src/runtime/executors/windows-stdio-supervisor.js';
import { mcpProcessEnvironment } from '../src/runtime/executors/mcp-wire-factory.js';
import { programLaunch } from '../src/runtime/program-launch.js';

test('Windows MCP 根握手只移除首行，协议原样传输，退出事实经 IPC', () => {
  const input = new PassThrough(), output = new PassThrough();
  const received: Buffer[] = []; output.on('data', data => received.push(data));
  const child = Object.assign(new EventEmitter(), { stdin: output });
  const config = { ...programLaunch('npx', ['-y', 'server with spaces'], 'win32'), cwd: 'C:\\中文 项目' };
  const messages: unknown[] = [];
  let spawned = false, exited = false;
  const fakeProcess = Object.assign(new EventEmitter(), { stdin: input, env: { MCP_KEY: 'private' }, argv: ['node', JSON.stringify(config)], send: (message: unknown) => messages.push(message), exit: () => { exited = true; } });
  const fakeRequire = (name: string) => { assert.equal(name, 'node:child_process'); return { spawn: (file: string, args: string[], options: any) => {
    spawned = true; assert.equal(file, config.file); assert.deepEqual(args, config.args);
    assert.deepEqual(options.stdio, ['pipe', 'inherit', 'inherit']); assert.equal(options.windowsVerbatimArguments, true);
    assert.equal(options.env.MCP_KEY, 'private'); return child;
  } }; };
  new Function('require', 'process', WINDOWS_STDIO_ROOT)(fakeRequire, fakeProcess);
  assert.equal(spawned, false);
  const first = Buffer.from('{"中文":"a\\nb"}\n');
  input.write(Buffer.concat([Buffer.from('\n'), first]));
  assert.equal(spawned, true);
  const second = Buffer.from([0, 255, 10]); input.write(second);
  assert.deepEqual(Buffer.concat(received), Buffer.concat([first, second]));
  child.emit('close', 0); assert.equal(exited, false); assert.deepEqual(messages, [{ targetClosed: true, code: 0 }]);
  fakeProcess.emit('message', { release: true }); assert.equal(exited, true);
  input.destroy(); output.destroy();
});
test('Windows MCP 环境按大小写保护监护器，不继承模型密钥且不公开私有值', () => {
  const source = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'model-secret' };
  assert.deepEqual(mcpProcessEnvironment({ MCP_KEY: 'private' }, source, 'win32'), { MCP_KEY: 'private', Path: 'C:\\bin', SystemRoot: 'C:\\Windows' });
  for (const key of ['pAtH', 'ComSpec', 'NODE_OPTIONS', 'OPENSSL_CONF'])
    assert.throws(() => mcpProcessEnvironment({ [key]: 'private' }, source, 'win32'), error => !String(error).includes('private'));
  assert.deepEqual(mcpProcessEnvironment({ PATH: 'override', MCP_KEY: 'private' }, { PATH: '/bin' }, 'darwin'), { MCP_KEY: 'private', PATH: '/bin' });
  assert.equal(programLaunch('uvx.exe', ['server'], 'win32').file, 'uvx.exe');
});

test('Windows MCP 取消发生在身份握手前时不放行，查询失败不提供停止证明', async () => {
  const { WINDOWS_STDIO_SUPERVISOR } = await import('../src/runtime/executors/windows-stdio-supervisor.js');
  const input = new EventEmitter(); let handshakes = 0, exited = false, failed = false, poll = () => {};
  let rows = [{ pid: 100, ppid: 1, identity: '2026-10-31T00:00:00.0000000Z', group: 0 }];
  const child = Object.assign(new EventEmitter(), { pid: 100, connected: true, stdin: Object.assign(new EventEmitter(), { end() {}, write() { handshakes++; return true; } }), send() {} });
  const fakeProcess = Object.assign(new EventEmitter(), { stdin: input, env: {}, execPath: 'node.exe', argv: ['node', JSON.stringify({ file: 'node.exe', args: ['server.js'], cwd: 'C:\\project' })], exit: () => { exited = true; } });
  const fakeRequire = () => ({ spawn: () => child, execFileSync: () => { if (failed) throw new Error('CIM unavailable'); return JSON.stringify(rows); } });
  new Function('require', 'process', 'setInterval', WINDOWS_STDIO_SUPERVISOR)(fakeRequire, fakeProcess, (callback: () => void) => { poll = callback; });
  input.emit('end'); child.emit('spawn'); poll();
  assert.equal(handshakes, 0);
  child.emit('close'); failed = true; poll(); assert.equal(exited, false);
  failed = false; rows = []; poll(); assert.equal(exited, true);
});
