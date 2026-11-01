import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcessService } from '../src/application/managed-process-service.js';
import { taskProcessAlive } from '../src/application/task-scheduler.js';
import { createProcessSupervisor, nativeTaskIsolation } from '../src/runtime/executors/process-runtime.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-win-command-'));
  const work = join(root, '中文 空格');
  await mkdir(work);
  const store = new SqliteAssistantStore(join(root, 'store.sqlite'));
  const service = new ManagedProcessService(store.managedProcesses, join(root, 'logs'), [],
    { isolation: nativeTaskIsolation, supervisors: createProcessSupervisor('win32') });
  const source = { sessionId: 'windows-session', executionId: 'turn-1', directory: work };
  return { root, work, service, source, close: async () => { await service.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

async function eventually(check: () => Promise<void> | void, attempts = 40): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await check(); return; }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw last;
}

function request(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    }).on('error', reject);
  });
}

test('Windows 共用命令可列中文目录并判定原生命令和 PowerShell 失败',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const f = await fixture();
    const secret = process.env.MULTIVAC_COMMAND_TEST_SECRET;
    try {
      await writeFile(join(f.work, '文件.txt'), 'content');
      let output = '';
      const listed = await f.service.bash.execute(f.source, 'list', { command: 'Get-ChildItem -Name' }, undefined,
        data => { output += data.toString('utf8'); });
      assert.equal(listed.exitCode, 0);
      assert.match(output, /文件\.txt/u);
      await eventually(() => assert.equal(f.service.get(listed.process.processId)?.state, 'exited'));

      const failed = await f.service.bash.execute(f.source, 'native-failure',
        { command: 'cmd.exe /c exit 7; Write-Output later' }, undefined, () => {});
      assert.equal(failed.exitCode, 7);
      await eventually(() => assert.equal(f.service.get(failed.process.processId)?.state, 'failed'));
      const scriptError = await f.service.bash.execute(f.source, 'script-failure',
        { command: "Write-Error 'failed'; Write-Output later" }, undefined, () => {});
      assert.notEqual(scriptError.exitCode, 0);
      process.env.MULTIVAC_COMMAND_TEST_SECRET = 'must-not-reach-child';
      const environment = await f.service.bash.execute(f.source, 'environment',
        { command: "if ($env:MULTIVAC_COMMAND_TEST_SECRET) { exit 9 }; Write-Output 'clean'" }, undefined, () => {});
      assert.equal(environment.exitCode, 0);
    } finally {
      if (secret === undefined) delete process.env.MULTIVAC_COMMAND_TEST_SECRET;
      else process.env.MULTIVAC_COMMAND_TEST_SECRET = secret;
      await f.close();
    }
  });

test('Windows 后台本地服务可访问、保留日志，并在停止后释放端口',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.work, 'server.cjs'),
        'const s=require("node:http").createServer((_q,r)=>r.end("windows-ok"));s.listen(0,"127.0.0.1",()=>console.log(s.address().port));');
      const started = await f.service.bash.execute(f.source, 'server',
        { command: 'node .\\server.cjs', mode: 'background', name: 'Windows 本地服务' }, undefined, () => {});
      assert.equal(started.process.state, 'running');
      let port = 0;
      await eventually(async () => {
        const log = (await f.service.logs(started.process.processId)).text;
        port = Number(log.trim());
        assert.ok(port > 0, JSON.stringify({ process: f.service.get(started.process.processId), log }));
        assert.equal(await request(port), 'windows-ok');
      });
      assert.equal((await f.service.stop(started.process.processId)).state, 'exited');
      await assert.rejects(request(port));
      const receipt = JSON.parse(await readFile(join(f.root, 'logs', `${started.process.processId}.exit.json`), 'utf8'));
      assert.equal(receipt.treeStopped, true);
    } finally { await f.close(); }
  });

test('Windows 前台命令取消、超时和输出额度耗尽均保留真实停止结果',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const running = f.service.bash.execute(f.source, 'cancel',
        { command: 'Start-Sleep -Seconds 30' }, controller.signal, () => {});
      await eventually(() => assert.equal(f.service.list(true).find(item => item.toolCallId === 'cancel')?.state, 'running'));
      controller.abort();
      await assert.rejects(running, /aborted/u);
      await eventually(() => assert.equal(f.service.list(true).find(item => item.toolCallId === 'cancel')?.state, 'exited'), 120);

      await assert.rejects(f.service.bash.execute(f.source, 'timeout',
        { command: 'Start-Sleep -Seconds 30', timeout: 0.2 }, undefined, () => {}), /timeout/u);
      await eventually(() => assert.equal(f.service.list(true).find(item => item.toolCallId === 'timeout')?.state, 'failed'), 120);

      const control = {
        start: () => ({ maxBytes: 100, maxMillis: 10_000 }),
        check: () => {}, progress: () => 100, settle: () => {},
      };
      await f.service.bash.execute(f.source, 'output-budget',
        { command: "1..200 | ForEach-Object { Write-Output 'abcdefgh' }" }, undefined, () => {}, undefined, undefined, control);
      await eventually(() => {
        const process = f.service.list(true).find(item => item.toolCallId === 'output-budget');
        assert.equal(process?.state, 'failed');
        assert.match(process.reason, /输出超过/u);
      }, 120);
    } finally { await f.close(); }
  });

test('Windows 命令根退出后仍追踪已观察的后台子进程',
  { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
    const f = await fixture();
    let worker = 0;
    try {
      await writeFile(join(f.work, 'launcher.cjs'), `const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});
worker.unref();writeFileSync('worker.pid',String(worker.pid));setTimeout(()=>process.exit(0),3000);`);
      const result = await f.service.bash.execute(f.source, 'descendant',
        { command: 'node .\\launcher.cjs' }, undefined, () => {});
      assert.equal(result.exitCode, 0);
      worker = Number(await readFile(join(f.work, 'worker.pid'), 'utf8'));
      assert.ok(taskProcessAlive(worker));
      assert.equal(result.process.state, 'running');
      assert.equal((await f.service.stop(result.process.processId)).state, 'exited');
      assert.equal(taskProcessAlive(worker), false);
      const receipt = JSON.parse(await readFile(join(f.root, 'logs', `${result.process.processId}.exit.json`), 'utf8'));
      assert.equal(receipt.treeStopped, true);
      assert.ok(receipt.tracked.some((entry: { pid: number }) => entry.pid === worker));
    } finally {
      if (worker && taskProcessAlive(worker)) { try { process.kill(worker); } catch { /* 测试收尾。 */ } }
      await f.close();
    }
  });
