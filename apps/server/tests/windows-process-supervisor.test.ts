import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
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

test('Windows 实机 CIM 观察身份并终止本次进程', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const tree = new Function('execFileSync', 'process', `${WINDOWS_PROCESS_TREE_TRACKER};return processTree(${child.pid});`)(execFileSync, process);
    assert.ok(tree.observe().some((entry: { pid: number }) => entry.pid === child.pid));
    tree.signal();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([once(child, 'exit'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('CIM 停止超时')), 15000); })]);
    } finally { clearTimeout(timeout); }
    assert.deepEqual(tree.observe(), []);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('Windows 实机根退出后仍追踪并停止已观察的子孙进程', { skip: process.platform !== 'win32' }, async () => {
  const grandchildCode = 'setInterval(() => {}, 1000)';
  const childCode = `const {spawn}=require('node:child_process');
const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{detached:true,stdio:'ignore'});
grandchild.unref();
console.log(JSON.stringify({child:process.pid,grandchild:grandchild.pid}));
setInterval(() => {}, 1000);`;
  const rootCode = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','inherit','inherit']});
child.unref();
process.stdin.once('data',()=>process.exit(0));`;
  const root = spawn(process.execPath, ['-e', rootCode], { stdio: ['pipe', 'pipe', 'ignore'] });
  let descendants: number[] = [];
  try {
    const [chunk] = await once(root.stdout!, 'data', { signal: AbortSignal.timeout(15000) });
    const ids = JSON.parse(String(chunk).trim()) as { child: number; grandchild: number };
    descendants = [ids.child, ids.grandchild];
    const tree = new Function('execFileSync', 'process', `${WINDOWS_PROCESS_TREE_TRACKER};return processTree(${root.pid});`)(execFileSync, process);
    let members: { pid: number }[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      members = tree.observe();
      if ([root.pid, ...descendants].every(pid => members.some(member => member.pid === pid))) break;
      await delay(250);
    }
    assert.ok([root.pid, ...descendants].every(pid => members.some(member => member.pid === pid)));
    root.stdin!.end('\n');
    await once(root, 'exit', { signal: AbortSignal.timeout(15000) });
    const afterRootExit = tree.observe() as { pid: number }[];
    assert.ok(descendants.every(pid => afterRootExit.some(member => member.pid === pid)),
      JSON.stringify({ descendants, afterRootExit, known: tree.identities(), alive: descendants.map(pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      }) }));
    tree.signal();
    for (let attempt = 0; attempt < 8 && tree.observe().length > 0; attempt++) await delay(250);
    assert.deepEqual(tree.observe(), []);
  } finally {
    if (root.exitCode === null) root.kill();
    for (const pid of descendants) { try { process.kill(pid); } catch { /* 已结束。 */ } }
  }
});
