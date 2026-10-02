import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

test('真实原生任务隔离拒绝越界、符号链接、网络、密钥环境和派生进程，停止等待真实退出', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-native-task-'));
  const work = join(root, 'work');
  await mkdir(work);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'private-probe');
  await symlink(outside, join(work, 'escape'));
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let tools: NativeTaskTools | undefined;
  try {
    tools = await NativeTaskTools.create(work);
    const inside = await tools.execute(process.execPath, ['-e', 'require("node:fs").writeFileSync("inside.txt","allowed");process.stdout.write("allowed")']);
    assert.equal(inside.code, 0, inside.output.toString());
    assert.equal(await readFile(join(work, 'inside.txt'), 'utf8'), 'allowed');
    const escape = await tools.execute('/bin/cat', [join(work, 'escape')]);
    assert.notEqual(escape.code, 0);
    assert.equal(escape.output.toString().includes('private-probe'), false);
    const write = await tools.execute(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', outside]);
    assert.notEqual(write.code, 0);
    assert.equal(await readFile(outside, 'utf8'), 'private-probe');
    const env = await tools.execute(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))']);
    assert.deepEqual(JSON.parse(env.output.toString()), ['HOME', 'LANG', 'OPENSSL_CONF', 'PATH', 'TMPDIR']);
    const fork = await tools.execute(process.execPath, ['-e', 'try{require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{detached:true,stdio:"ignore"});process.exit(2)}catch{process.stdout.write("denied")}']);
    assert.equal(fork.code, 0);
    assert.equal(fork.output.toString(), 'denied');
    const network = await tools.execute(process.execPath, ['-e', 'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>process.exit(2));s.on("error",()=>process.exit(0));', String(address.port)]);
    assert.equal(network.code, 0);
    const controller = new AbortController();
    const pending = tools.execute(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    assert.equal((await pending).code, null);
  } finally {
    tools?.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('实际文件工具在写入前取得租约，失效时不产生文件', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-native-lease-'));
  let allowed = true;
  const phases: string[] = [];
  const tools = await NativeTaskTools.create(root, [], (phase) => {
    if (phase === 'starting' && !allowed) throw new Error('lease-invalid');
    phases.push(phase); return 1024 * 1024;
  });
  try {
    const write = tools.definitions().find((tool) => tool.name === 'write')!;
    await write.execute('first', { path: 'good.txt', content: 'real-output' }, new AbortController().signal, undefined, {} as ExtensionContext);
    assert.equal(await readFile(join(root, 'good.txt'), 'utf8'), 'real-output');
    assert.deepEqual(phases, ['starting', 'settled', 'starting', 'settled']);
    allowed = false;
    await assert.rejects(write.execute('second', { path: 'blocked.txt', content: 'must-not-write' }, undefined, undefined, {} as ExtensionContext), /lease-invalid/);
    await assert.rejects(readFile(join(root, 'blocked.txt')), { code: 'ENOENT' });
    assert.equal(tools.processesStopped, true);
  } finally { tools.dispose(); await rm(root, { recursive: true, force: true }); }
});
