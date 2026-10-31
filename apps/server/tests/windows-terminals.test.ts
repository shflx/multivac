import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TerminalProcess, windowsTerminalLaunch, terminalCommand } from '../src/runtime/executors/terminal-process.js';
import { WINDOWS_TERMINAL_ROOT, WINDOWS_TERMINAL_WATCHER } from '../src/runtime/executors/windows-terminal-supervisor.js';
import { resolveWindowsProgram } from '../src/runtime/program-launch.js';
import { codexAppServerLaunch } from '../src/runtime/executors/codex-app-server.js';

test('Windows 终端默认 PowerShell，CLI 复用原生/批处理 argv，app-server 限回环', () => {
  const environment = { SystemRoot: 'C:\\Windows', Path: 'C:\\CLI Tools' };
  assert.match(windowsTerminalLaunch({ kind: 'blank' }, environment).file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
  const preset = { kind: 'custom' as const, executable: 'C:\\CLI Tools\\app.exe', argv: ['中文 路径', 'a"b', 'a%b', ''] };
  assert.deepEqual(windowsTerminalLaunch(preset, environment).args, preset.argv);
  const batch = windowsTerminalLaunch({ kind: 'custom', executable: 'C:\\CLI Tools\\app.cmd', argv: ['中文 路径'] }, environment);
  assert.match(batch.file, /cmd\.exe$/u); assert.match(batch.args.at(-1)!, /"中文 路径"/u);
  assert.equal(resolveWindowsProgram('codex', environment, file => file === 'C:\\CLI Tools\\codex.cmd'), 'C:\\CLI Tools\\codex.cmd');
  assert.equal(resolveWindowsProgram('codex', environment, file => ['C:\\CLI Tools\\codex.cmd', 'C:\\CLI Tools\\codex.exe'].includes(String(file))), 'C:\\CLI Tools\\codex.exe');
  assert.equal(terminalCommand({ kind: 'custom', executable: 'tool', argv: ["a'b"] }), "exec 'tool' 'a'\\''b'");
  assert.deepEqual(codexAppServerLaunch('ws://127.0.0.1:12345', {}).args, ['app-server', '--listen', 'ws://127.0.0.1:12345']);
  for (const endpoint of ['ws://example.com:12345', 'ws://127.0.0.1:12345/secret', 'wss://127.0.0.1:12345']) assert.throws(() => codexAppServerLaunch(endpoint, {}));
});

test('ConPTY 等身份与目标观察后放行输入，根退出仍需监护器停止凭据', async () => {
  const writes: (string | Buffer)[] = []; let exit = (_: { exitCode: number }) => {};
  const watcher = Object.assign(new EventEmitter(), { connected: true, send: (_: unknown) => {} });
  const fakePty = { pid: 100, write(data: string | Buffer) { writes.push(data); }, resize() {}, pause() {}, resume() {},
    onData: () => ({ dispose() {} }), onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} }; } };
  let conpty = false;
  const terminal = new TerminalProcess('C:\\中文 项目', { kind: 'blank' }, { cols: 80, rows: 24 }, 'win32', {
    spawnPty: ((file: string, args: string[], options: any) => {
      assert.equal(file, process.execPath); conpty = options.useConpty;
      assert.equal(JSON.parse(args[2]!).cwd, 'C:\\中文 项目'); return fakePty;
    }) as any,
    spawnWatcher: (() => watcher) as any, stopTimeoutMillis: 20,
  });
  try {
    assert.equal(conpty, true); terminal.pty.write('你好\r'); assert.equal(writes.length, 0);
    watcher.emit('message', { ready: true }); assert.deepEqual(writes, ['\r']);
    watcher.emit('message', { started: true }); assert.equal(String(writes[1]), '你好\r');
    watcher.emit('message', { queryFailed: true }); await assert.rejects(terminal.observe());
    exit({ exitCode: 0 }); assert.equal(await terminal.stop(), false);
    watcher.emit('message', { stopped: true }); watcher.emit('close', 0, null);
    assert.equal(await terminal.stop(), true);
    terminal.pty.write('late'); assert.equal(writes.length, 2);
  } finally { terminal.dispose(); }
});

test('ConPTY 根只在握手后用继承的控制台启动 CLI，不使用 shell 解释器', () => {
  const input = new PassThrough(); let launched = false, exitCode = -1;
  const child = new EventEmitter();
  const config = { file: 'C:\\工具\\cli.exe', args: ['a b', '"x"'], cwd: 'C:\\项目' };
  const fakeProcess = { stdin: input, argv: ['node', JSON.stringify(config)], env: {}, stderr: { write() {} }, exit: (code: number) => { exitCode = code; } };
  new Function('require', 'process', WINDOWS_TERMINAL_ROOT)(() => ({ spawn: (file: string, args: string[], options: any) => {
    launched = true; assert.equal(file, config.file); assert.deepEqual(args, config.args);
    assert.equal(options.shell, false); assert.equal(options.stdio, 'inherit'); return child;
  } }), fakeProcess);
  assert.equal(launched, false); input.write(Buffer.from('\r')); assert.equal(launched, true);
  child.emit('close', 7); assert.equal(exitCode, 7); input.destroy();
});

test('终端监护器在宿主断开后清理，查询失败和 PID 复用不提供错误停止证明', () => {
  let poll = () => {}, failed = false, ended = false;
  const root = { pid: 100, ppid: 1, identity: '2026-10-31T00:00:00.0000000Z' }, child = { pid: 101, ppid: 100, identity: '2026-10-31T00:00:01.0000000Z' };
  let rows = [root, child]; const messages: any[] = [], commands: string[] = [];
  const fakeProcess = Object.assign(new EventEmitter(), { argv: ['node', '100'], env: {}, connected: true, send: (message: unknown, callback?: () => void) => { messages.push(message); callback?.(); }, exit: () => { ended = true; } });
  new Function('require', 'process', 'setInterval', WINDOWS_TERMINAL_WATCHER)(() => ({ execFileSync: (_: string, args: string[]) => {
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le'); commands.push(script);
    if (failed) throw new Error('CIM unavailable'); return JSON.stringify(rows);
  } }), fakeProcess, (callback: () => void) => { poll = callback; });
  poll(); assert.ok(messages.some(message => message.ready)); assert.ok(messages.some(message => message.started));
  fakeProcess.emit('disconnect'); failed = true; poll(); assert.equal(ended, false);
  failed = false; rows = [{ ...root, identity: '2026-10-31T00:00:02.0000000Z' }, child]; poll(); assert.equal(ended, false);
  assert.ok(commands.some(command => command.includes('Invoke-CimMethod') && command.includes('ProcessId=101') && !command.includes('ProcessId=100')));
  rows = [{ ...root, identity: '2026-10-31T00:00:02.0000000Z' }]; poll(); assert.equal(ended, true); assert.ok(messages.some(message => message.stopped));
});
