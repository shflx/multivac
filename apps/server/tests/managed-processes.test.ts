import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

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
      socket.on('error',()=>require('node:http').createServer((req,res)=>res.end('isolated-development-service')).listen(${port},'127.0.0.1'));
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
    await assert.rejects(service.start({ ...input, name: 'changed' }, boundary), /参数/);
    const stopped = await service.stop(started.processId);
    assert.equal(stopped.state, 'exited');
    assert.ok(stopped.endedAt);
    assert.deepEqual(await service.stop(started.processId), stopped);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    const receipt = JSON.parse(await readFile(join(privateRoot, `${started.processId}.exit.json`), 'utf8'));
    assert.equal(receipt.stopping, true);
  } finally { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); }
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
