import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalScreen } from '../src/modules/terminals/terminal-screen.js';
import { TerminalProcess, shellQuote, terminalEnvironment } from '../src/runtime/executors/terminal-process.js';
const size = { cols: 80, rows: 24 };
const flow = { pause() {}, resume() {} };
test('完整UTF-8/CSI边界后快照，等待不阻塞解析，超时只拒绝快照', async () => {
  const screen = new TerminalScreen(size, flow);
  try {
    const bytes = Buffer.from('你好'); screen.output(bytes.subarray(0, 2));
    const pending = screen.snapshot();
    screen.output(bytes.subarray(2)); screen.output(Buffer.from('\x1b['));
    await pending;
    const csi = screen.snapshot(); screen.output(Buffer.from('31m红色'));
    const snapshot = await csi;
    assert.match(snapshot.data.toString(), /你好/); assert.match(snapshot.data.toString(), /红色/);
    assert.equal(snapshot.watermark, bytes.length + Buffer.byteLength('\x1b[31m红色'));
    screen.output(Buffer.from('\x1b]2;unfinished'));
    await assert.rejects(screen.snapshot(), /SNAPSHOT_TIMEOUT/);
    screen.output(Buffer.from('\x07after')); await screen.snapshot();
  } finally { screen.dispose(); }
});
test('serialize恢复bold/dim、备用屏颜色及隐藏光标', async () => {
  const screen = new TerminalScreen(size, flow); const restored = new TerminalScreen(size, flow);
  try {
    screen.output(Buffer.from('\x1b[1;2mA\x1b[22;1mB\x1b[22;2mC\x1b[31;44m\x1b[?1049h\x1b[0mALT\x1b[?25l'));
    const snapshot = await screen.snapshot(); restored.output(snapshot.data); await restored.drain();
    assert.equal(restored.terminal.buffer.active.type, 'alternate');
    const cell = restored.terminal.buffer.active.getLine(0)!.getCell(3)!;
    assert.equal(cell.getChars(), 'A'); assert.equal(cell.isFgDefault(), true); assert.equal(cell.isBgDefault(), true);
    assert.match((await restored.snapshot()).data.toString(), /\x1b\[\?25l$/);
    screen.output(Buffer.from('\x1b[?1049l')); restored.output(Buffer.from('\x1b[?1049l')); await screen.drain(); await restored.drain();
    for (let col = 0; col < 3; col++) {
      const a = screen.terminal.buffer.active.getLine(0)!.getCell(col)!; const b = restored.terminal.buffer.active.getLine(0)!.getCell(col)!;
      assert.equal(!!a.isBold(), !!b.isBold()); assert.equal(!!a.isDim(), !!b.isDim());
    }
  } finally { screen.dispose(); restored.dispose(); }
});
test('解析背压阈值、1000行裁剪及通知不误计OSC结束BEL', async () => {
  let paused = 0; let resumed = 0; let notices = 0;
  const screen = new TerminalScreen(size, { pause() { paused++; }, resume() { resumed++; } });
  screen.onNotification = () => notices++;
  try {
    screen.output(Buffer.from('\x1b]2;title\x07\x07\x1b]9;hi\x1b')); screen.output(Buffer.from('\\\x1b]777;notify;hi\x07'));
    screen.output(Buffer.from('line\r\n'.repeat(50000))); await screen.drain();
    assert.equal(notices, 3); assert.ok(paused > 0); assert.ok(resumed > 0);
    const snapshot = await screen.snapshot(); assert.equal(snapshot.historyTrimmed, true); assert.equal(screen.terminal.buffer.normal.length, 1024);
  } finally { screen.dispose(); }
});
test('真实PTY参数边界、环境、exit 1与停止核对', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'multivac-terminal-'));
  const env = terminalEnvironment({ PATH: '/bin', MULTIVAC_REMOTE_TOKEN: 'secret', OPENAI_API_KEY: 'secret', HELLO: 'ok' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.MULTIVAC_REMOTE_TOKEN, undefined); assert.equal(env.HELLO, 'ok');
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const process = new TerminalProcess(directory, { kind: 'custom', executable: '/bin/sh', argv: ['-c', 'printf "%s" "$1"; exit 1', 'sh', "a b'c"] }, size);
  let output = ''; process.onOutput = data => { output += data.toString(); };
  try {
    const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PTY退出超时')), 8000); process.onExit = exit => { clearTimeout(timer); resolve(exit); };
    });
    assert.equal(exit.exitCode, 1); assert.match(output, /a b'c/); assert.equal(await process.stop(), true);
  } finally { await process.stop(); process.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
test('真实PTY：暂停读取时仍收尾已观察到的脱组后代，并保留信号退出', { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 12000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'multivac-terminal-tree-'));
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log('CHILD:'+child.pid);setInterval(()=>process.stdout.write('output\\n'),100);`;
  const process = new TerminalProcess(directory, { kind: 'custom', executable: globalThis.process.execPath, argv: ['-e', script] }, size);
  let child = 0; let buffer = '';
  process.onOutput = data => { buffer += data.toString(); child = Number(/CHILD:(\d+)/.exec(buffer)?.[1] ?? child); };
  try {
    const start = Date.now(); while (!child) { if (Date.now() - start > 5000) throw new Error('未观察到后代PID'); await new Promise(resolve => setTimeout(resolve, 30)); }
    await process.observe(); process.pty.pause();
    assert.equal(await process.stop(), true);
    assert.ok(process.result?.signal); assert.equal(process.result?.signal, 15);
    assert.throws(() => globalThis.process.kill(child, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  } finally { await process.stop(); process.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('并发快照在各自队列位置读取尺寸和字节水位，不越过已排队的输出/resize', async () => {
  const screen = new TerminalScreen(size, flow);
  try {
    screen.output(Buffer.from('BEFORE'));
    const before = screen.snapshot();
    const resized = screen.resize({ cols: 40, rows: 8 });
    screen.output(Buffer.from('AFTER'));
    const after = screen.snapshot();
    const [a, , b] = await Promise.all([before, resized, after]);
    assert.deepEqual(a.size, size); assert.equal(a.watermark, 6); assert.ok(!a.data.toString().includes('AFTER'));
    assert.deepEqual(b.size, { cols: 40, rows: 8 }); assert.equal(b.watermark, 11); assert.match(b.data.toString(), /BEFOREAFTER/);
    assert.ok(b.sequence > a.sequence);
  } finally { screen.dispose(); }
});
