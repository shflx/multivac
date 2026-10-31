import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { WINDOWS_PROCESS_TREE_TRACKER, WINDOWS_COMMAND_SUPERVISOR } from '../src/runtime/executors/windows-process-supervisor.js';

const identity = '2026-10-31T00:00:00.0000000Z';
test('CIM 仅归属观察到的后代；PID 复用、查询失败或终止返回不构成停止证明', () => {
  let rows = [{ pid: 100, ppid: 1, identity, group: 0 }, { pid: 101, ppid: 100, identity, group: 0 }];
  let failure = false;
  const signals: string[] = [];
  const exec = (_file: string, args: string[]) => {
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    if (script.includes('Invoke-CimMethod')) { signals.push(script); return ''; }
    if (failure) throw new Error('CIM unavailable');
    return JSON.stringify(rows);
  };
  const tree = new Function('execFileSync', 'process', `${WINDOWS_PROCESS_TREE_TRACKER};return processTree(100);`)(exec, { env: {} });
  assert.equal(tree.rootObserved(), false);
  assert.deepEqual(tree.observe().map((p: { pid: number }) => p.pid), [100, 101]);
  tree.signal();
  assert.equal(signals.length, 2);
  assert.match(signals[0]!, /CreationDate/);
  assert.equal(tree.observe().length, 2); // 终止调用返回不代表进程已退出。
  rows = [{ pid: 100, ppid: 1, identity: '2027-01-01T00:00:00Z', group: 0 }, { pid: 102, ppid: 100, identity, group: 0 }];
  assert.deepEqual(tree.observe(), []); // 不接管复用根或其后代。
  failure = true;
  assert.throws(() => tree.observe(), /CIM unavailable/);
  assert.throws(() => tree.signal(), /CIM unavailable/);
});

test('Windows 命令监护握手后才放行；根退出但查询失败时不生成停止凭据', () => {
  const input = new EventEmitter(), child = new EventEmitter() as EventEmitter & Record<string, any>;
  child.pid = 100; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let unlocked = false, poll = () => {}, failed = false, exited = false;
  child.stdin = Object.assign(new EventEmitter(), { end: () => { unlocked = true; } });
  let rows = [{ pid: 100, ppid: 1, identity, group: 0 }];
  const files = new Map<string, string>();
  const messages: any[] = [];
  const requireMock = (name: string) => {
    if (name === 'node:readline') return { createInterface: () => input };
    if (name === 'node:child_process') return { spawn: () => child, execFileSync: () => { if (failed) throw new Error('CIM unavailable'); return JSON.stringify(rows); } };
    if (name === 'node:fs') return { writeFileSync: (path: string, value: string) => files.set(path, value), renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); } };
    throw new Error(name);
  };
  const processMock = { env: {}, stdin: {}, stdout: { write: (value: string, done?: () => void) => { messages.push(JSON.parse(value)); done?.(); } }, on() {}, exit: () => { exited = true; } };
  new Function('require', 'process', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', WINDOWS_COMMAND_SUPERVISOR)(requireMock, processMock,
    (callback: () => void) => { poll = callback; return 1; }, () => {}, () => 1, () => {});
  input.emit('line', JSON.stringify({ log: 'log', receipt: 'receipt', token: 'token', directory: 'C:\\project', shellLaunch: { file: 'powershell.exe', args: [] }, maxBytes: null }));
  assert.equal(unlocked, false);
  child.emit('spawn'); poll(); assert.equal(unlocked, true);
  assert.ok(messages.some(message => message.pid === 100));
  child.emit('exit', 0); child.emit('close', 0); failed = true; poll();
  assert.equal(files.has('receipt'), false); assert.equal(exited, false);
  failed = false; rows = []; poll();
  assert.equal(exited, true); assert.equal(JSON.parse(files.get('receipt')!).treeStopped, true);
});
