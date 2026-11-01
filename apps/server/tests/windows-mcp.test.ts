import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOWS_STDIO_ROOT, WINDOWS_STDIO_SUPERVISOR } from '../src/runtime/executors/windows-stdio-supervisor.js';
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
  assert.match(programLaunch('uvx.exe', ['server'], 'win32').file, /uvx\.exe$/u);
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

test('Windows 实机 MCP stdio 经 Node 和 .cmd 传输中文协议并确认退出', { skip: process.platform !== 'win32', timeout: 40_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-mcp-real-'));
  try {
    const fixture = join(root, 'mcp-夹具.cjs');
    await writeFile(fixture, `let pending='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{pending+=chunk;let index;
 while((index=pending.indexOf('\\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);
  if(!line.trim())continue;const request=JSON.parse(line);
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{echo:request.params?.text}})+'\\n');
 }});
process.stdin.on('end',()=>process.exit(0));`);
    const batch = join(root, 'mcp-launcher.cmd');
    await writeFile(batch, `@echo off\r\n"${process.execPath}" "%~dp0mcp-夹具.cjs"\r\n`);
    for (const [command, args] of [[process.execPath, [fixture]], [batch, []]] as const) {
      const launch = programLaunch(command, args, 'win32');
      const child = spawn(process.execPath, ['-e', WINDOWS_STDIO_SUPERVISOR, JSON.stringify({ ...launch, cwd: root })],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      const closed = once(child, 'close');
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'echo', params: { text: '中文协议' } }) + '\n');
        for (let attempt = 0; attempt < 100 && !output.includes('中文协议'); attempt++)
          await new Promise(resolve => setTimeout(resolve, 100));
        assert.deepEqual(JSON.parse(output.trim()), { jsonrpc: '2.0', id: 1, result: { echo: '中文协议' } });
        child.stdin.end();
        const [code, signal] = await closed;
        assert.equal(code, 0, error); assert.equal(signal, null);
      } finally {
        if (child.exitCode === null) child.stdin.end();
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
