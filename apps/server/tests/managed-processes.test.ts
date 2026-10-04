import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { NativeTaskTools } from '../src/runtime/executors/native-task-tools.js';
import { MANAGED_SUPERVISOR } from '../src/runtime/executors/managed-process-supervisor.js';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

test('已有版本 25 数据目录补建托管表，不移动或重复执行历史迁移', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-process-migration-'));
  const path = join(root, 'store.sqlite');
  try {
    const first = new SqliteAssistantStore(path); first.close();
    const old = new DatabaseSync(path);
    old.exec('DROP TABLE managed_process_command; DROP TABLE managed_process; DELETE FROM schema_migrations WHERE version=26;');
    old.close();
    const upgraded = new SqliteAssistantStore(path);
    assert.deepEqual(upgraded.managedProcesses.all(), []);
    assert.deepEqual(upgraded.taskRuns.active(), []);
    upgraded.close();
    const inspection = new DatabaseSync(path);
    assert.equal(inspection.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count, 26);
    inspection.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实托管服务：回环监听、目录/网络/凭据/后代隔离、幂等与停止证明', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-managed-'));
  const work = join(root, 'work'), privateRoot = join(root, 'private');
  await mkdir(work); await mkdir(privateRoot);
  const store = new SqliteAssistantStore(join(privateRoot, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, privateRoot, [privateRoot]);
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  let networkEscaped = false;
  const outsideServer = createServer((socket) => { networkEscaped = true; socket.destroy(); });
  await new Promise<void>((resolve) => outsideServer.listen(0, '127.0.0.1', resolve));
  const outsidePort = (outsideServer.address() as { port: number }).port;
  const boundary = { taskId: 'task', runId: 'run', sessionId: 'session', directory: work, maxMillis: 10000, maxBytes: 100000 };
  try {
    await writeFile(join(root, 'secret'), 'must-not-read');
    await writeFile(join(work, 'server.cjs'), `
      const fs=require('node:fs');
      try { fs.readFileSync(${JSON.stringify(join(root, 'secret'))}); throw Error('escape'); } catch(e) { if(e.message==='escape') process.exit(41); }
      try { fs.writeFileSync(${JSON.stringify(join(root, 'outside'))},'escape'); process.exit(42); } catch {}
      if (process.env.OPENAI_API_KEY || process.env.MULTIVAC_DATA_DIR) process.exit(43);
      try { require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true}); process.exit(44); } catch {}
      const socket=require('node:net').connect(80,'1.1.1.1');
      socket.on('connect',()=>process.exit(45));
      socket.on('error',()=>{
        const local=require('node:net').connect(${outsidePort},'127.0.0.1');
        local.on('connect',()=>process.exit(46));
        local.on('error',()=>require('node:http').createServer((req,res)=>res.end('isolated-development-service')).listen(${port},'127.0.0.1'));
      });
    `);
    const input = { commandId: 'start', name: '开发服务', script: 'server.cjs', port, requiredWhileRunning: false };
    const [started, duplicate] = await Promise.all([service.start(input, boundary), service.start(input, boundary)]);
    assert.equal(started.processId, duplicate.processId);
    assert.equal(store.managedProcesses.all().length, 1);
    let response = '';
    for (let i = 0; i < 30; i++) {
      try { response = await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(100) })).text(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.equal(response, 'isolated-development-service', JSON.stringify(service.list()) + await readFile(join(privateRoot, `${started.processId}.log`), 'utf8').catch(() => ''));
    assert.equal(networkEscaped, false);
    await service.observe();
    assert.equal(service.list()[0]!.port, port);
    await assert.rejects(service.start({ ...input, name: 'changed' }, boundary), /参数/);
    const stopped = await service.stop(started.processId);
    assert.equal(stopped.state, 'exited');
    assert.ok(stopped.endedAt);
    assert.deepEqual(await service.stop(started.processId), stopped);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    const receipt = JSON.parse(await readFile(join(privateRoot, `${started.processId}.exit.json`), 'utf8'));
    assert.equal(receipt.stopping, true);
  } finally { await service.close(); await new Promise<void>((resolve) => outsideServer.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实长命令超预算退出、启动失败保留记录、未知凭据不按 PID 假报停止', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-managed-budget-'));
  const work = join(root, 'work'), privateRoot = join(root, 'private');
  await mkdir(work); await mkdir(privateRoot);
  const store = new SqliteAssistantStore(join(privateRoot, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, privateRoot, [privateRoot]);
  const boundary = { taskId: 'task', runId: 'run', sessionId: 'session', directory: work, maxMillis: 100, maxBytes: 1000 };
  try {
    await writeFile(join(work, 'long.cjs'), "setInterval(()=>process.stdout.write('working\\n'),10)");
    const started = await service.start({ commandId: 'long', name: '长命令', script: 'long.cjs', port: null, requiredWhileRunning: true }, boundary);
    for (let i = 0; i < 40 && service.list()[0]!.endedAt === null; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(service.list()[0]!.endedAt);
    const failed = await service.start({ commandId: 'bad', name: '失败', script: '../missing.cjs', port: null, requiredWhileRunning: true }, boundary);
    assert.equal(failed.state, 'failed');
    const old = store.managedProcesses.get(started.processId)!;
    old.public.state = 'running'; old.public.endedAt = null; old.token = 'different'; old.pid = process.pid;
    store.managedProcesses.save(old);
    await service.reconcile(started.processId);
    assert.equal(store.managedProcesses.get(started.processId)!.public.state, 'recovery');
  } finally { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实服务管道断开触发强制收敛，重启仅凭私有退出凭据恢复', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-managed-crash-'));
  const work = join(root, 'work'), privateRoot = join(root, 'private');
  await mkdir(work); await mkdir(privateRoot);
  const store = new SqliteAssistantStore(join(privateRoot, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, privateRoot, [privateRoot]);
  const tools = await NativeTaskTools.create(work, [privateRoot]);
  const supervisor = spawn(process.execPath, ['-e', MANAGED_SUPERVISOR], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  const closed = new Promise<void>((resolve) => supervisor.once('close', () => resolve()));
  try {
    let protocol = '';
    const pid = new Promise<number>((resolve) => supervisor.stdout.on('data', (chunk) => { protocol += chunk.toString(); if (protocol.includes('\n')) resolve(JSON.parse(protocol.split('\n')[0]!).pid); }));
    supervisor.stdin.write(JSON.stringify({ profile: tools.managedProfile(null), directory: work, executable: process.execPath,
      args: ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], token: 'private-token',
      log: join(privateRoot, 'crashed.log'), receipt: join(privateRoot, 'crashed.exit.json'), maxMillis: 5000, maxBytes: 1000 }) + '\n');
    const childPid = await pid;
    store.managedProcesses.save({ commandId: 'crashed', fingerprint: '', token: 'private-token', pid: childPid, directory: work, ownerId: 'old-service',
      public: { processId: 'crashed', taskId: 'task', runId: 'run', sessionId: 'session', revision: 1, name: '崩溃恢复', command: 'node', state: 'running', requiredWhileRunning: true, startedAt: new Date().toISOString(), endedAt: null, port: null, exitCode: null, reason: '' } });
    let output = '';
    for (let i = 0; i < 40 && !output.includes('ready'); i++) {
      output = await readFile(join(privateRoot, 'crashed.log'), 'utf8').catch(() => '');
      if (!output.includes('ready')) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /ready/);
    supervisor.stdin.end();
    await closed;
    assert.equal(JSON.parse(await readFile(join(privateRoot, 'crashed.exit.json'), 'utf8')).signal, 'SIGKILL');
    await service.recover();
    assert.ok(service.list()[0]!.endedAt);
    assert.equal(service.hasDirectoryLease(work), false);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally { supervisor.stdin.end(); await closed; tools.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('用户取消不停止，过期影响预览拒绝，重复停止命令不重放副作用', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-managed-confirm-'));
  const work = join(root, 'work'), privateRoot = join(root, 'private'); await mkdir(work); await mkdir(privateRoot);
  const store = new SqliteAssistantStore(join(privateRoot, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, privateRoot, [privateRoot]);
  try {
    await writeFile(join(work, 'long.cjs'), 'setInterval(()=>{},1000)');
    const item = await service.start({ commandId: 'start', name: '依赖', script: 'long.cjs', port: null, requiredWhileRunning: true }, { taskId: 'task', runId: 'run', sessionId: 'session', directory: work, maxMillis: 5000, maxBytes: 1000 });
    const task = { revision: 1, status: 'running' };
    const preview = service.preview(item.processId, task);
    const input = { commandId: 'stop', revision: preview.process.revision, taskRevision: 1, confirmed: false };
    await assert.rejects(service.stopChecked(item.processId, input, task), /确认/);
    assert.equal(service.list()[0]!.state, 'running');
    await assert.rejects(service.stopChecked(item.processId, { ...input, confirmed: true }, { ...task, revision: 2 }), /变化/);
    const receipt = await service.stopChecked(item.processId, { ...input, confirmed: true }, task);
    assert.equal(receipt.state, 'stopping');
    assert.equal(service.list()[0]!.state, 'exited');
    assert.deepEqual(await service.stopChecked(item.processId, { ...input, confirmed: true }, task), receipt);
    await assert.rejects(service.stopChecked(item.processId, input, task), /参数/);
    const retained = await service.start({ commandId: 'retained', name: '独立进程', script: 'long.cjs', port: null, requiredWhileRunning: false }, { taskId: 'task', runId: 'run', sessionId: 'session', directory: work, maxMillis: 5000, maxBytes: 1000 });
    assert.equal(retained.state, 'running');
    await service.close();
    assert.equal(store.managedProcesses.get(retained.processId)!.public.state, 'exited');
    assert.equal(service.hasDirectoryLease(work), false);
  } finally { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
