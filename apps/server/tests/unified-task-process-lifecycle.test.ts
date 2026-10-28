import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function eventually(check: () => Promise<void> | void, attempts = 200) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) { try { await check(); return; } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 50)); } }
  throw last;
}
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

for (const action of ['complete', 'pause', 'cancel', 'budget', 'output'] as const) {
  test(`真实任务进程树：${action} 核对浏览器、脱组 worker、HTTP 服务与端口退出`, { timeout: 40_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'multivac-unified-tree-'));
    const source = join(root, 'source'); await mkdir(source);
    const script = `
const {chromium}=require(${JSON.stringify(resolve('node_modules/playwright'))});
const {spawn}=require('node:child_process');
(async()=>{
 const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 const server=require('node:http').createServer((q,r)=>r.end('ready'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 console.log(JSON.stringify({ready:true,port:server.address().port,worker:worker.pid}));
 if(${JSON.stringify(action)}==='complete'){
   await new Promise(resolve=>setTimeout(resolve,250));await browser.close();worker.kill('SIGTERM');server.close();
 }else{setInterval(()=>${JSON.stringify(action)}==='output'?console.log('x'.repeat(2048)):undefined,50);}
})().catch(e=>{console.error(e);process.exitCode=1;});
`;
    await writeFile(join(source, 'tree.cjs'), script);
    const app = createMultivacApplication(testApplicationEnvironment(root));
    try {
      await app.ready;
      await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
      const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const response = await fetch(api + '/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '进程树测试', directory: source }) });
      assert.equal(response.ok, true);
      const { project } = await response.json() as { project: { projectId: string } };
      const command = `PLAYWRIGHT_BROWSERS_PATH=${quote(resolve('.tmp/browsers'))} ${quote(process.execPath)} tree.cjs`;
      const task = app.tasks.create({ commandId: 'task', title: '真实进程树', projectId: project.projectId,
        goal: `bash执行：${JSON.stringify({ command })}`, acceptance: true,
        budget: { maxRuns: 2, maxMillis: action === 'budget' ? 4500 : 20000, maxOutputBytes: action === 'output' ? 18000 : 200000 } }).task;
      await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
      let proof!: { port: number; worker: number };
      await eventually(async () => {
        const item = app.managedProcesses.list(true)[0]; assert.ok(item);
        const log = (await app.managedProcesses.logs(item.processId)).text;
        const line = log.split('\n').find(line => line.startsWith('{"ready":true'));
        assert.ok(line, log); proof = JSON.parse(line);
      });
      if (action === 'pause' || action === 'cancel') {
        assert.equal(await (await fetch(`http://127.0.0.1:${proof.port}`)).text(), 'ready');
        const current = app.tasks.get(task.taskId);
        await app.taskExecution.control(task.taskId, { commandId: action, revision: current.revision, action });
      }
      await eventually(() => assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, true));
      const detail = app.tasks.detail(task.taskId), run = detail.runs![0]!;
      assert.deepEqual(run.nativePendingIds, []);
      if (action === 'cancel') assert.equal(detail.task.status, 'cancelled');
      if (action === 'pause' || action === 'budget' || action === 'output') assert.equal(detail.task.status, 'paused');
      if (action === 'budget' || action === 'output') assert.equal(detail.task.pauseSource, 'budget');
      const item = app.managedProcesses.list(true)[0]!;
      assert.ok(['exited', 'failed'].includes(item.state), JSON.stringify(item));
      const receipt = JSON.parse(await readFile(join(app.paths.dataDir, 'managed-processes', `${item.processId}.exit.json`), 'utf8'));
      assert.equal(receipt.treeStopped, true);
      assert.ok(receipt.tracked.some((p: { pid: number }) => p.pid === proof.worker), JSON.stringify(receipt));
      assert.ok(receipt.tracked.length >= 3);
      assert.throws(() => process.kill(proof.worker, 0), { code: 'ESRCH' });
      await assert.rejects(fetch(`http://127.0.0.1:${proof.port}`));
      const revision = detail.task.revision;
      await app.taskExecution.reconcileFinalizations();
      assert.equal(app.tasks.get(task.taskId).revision, revision);
    } finally {
      app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve()));
      await app.close(); await rm(root, { recursive: true, force: true });
    }
  });
}
