import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

const exec = promisify(execFile);
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

/** 模型输出为确定性脚本；Pi、工具装配、Task/Run、OS、npm、浏览器、HTTP、Git 与成果存储均真实。 */
test('真实 Pi 两类会话对照：安装、失败测试、修复、构建、浏览器与 HTTP、本地提交及人工审核', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-unified-pi-'));
  const source = join(root, 'source'); await mkdir(source);
  const model = await startScriptedModel();
  const data = testDataDir(root);
  await configureScriptedModel(join(data, 'pi'), model.endpoint);
  await writeFile(join(data, 'model-settings.json'), JSON.stringify({ revision: 0, profiles: [{ profileId: 'scripted', displayName: '受控脚本模型', provider: 'local-scripted', modelId: 'scripted', protocol: 'openai-completions', endpoint: model.endpoint }], defaultProfileId: 'scripted', commands: [] }));
  const git = (directory: string, args: string[]) => exec('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', directory, ...args]);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'controlled-unified-development', version: '1.0.0', scripts: { build: 'node --check value.cjs', test: 'node --test value.test.cjs' } }));
  await writeFile(join(source, '.gitignore'), 'node_modules/\n');
  await writeFile(join(source, 'value.cjs'), 'exports.value = 1;\n');
  await writeFile(join(source, 'value.test.cjs'), "require('node:test')('value',()=>require('node:assert/strict').equal(require('./value.cjs').value,42));\n");
  const playwrightModule = fileURLToPath(new URL('../../../node_modules/playwright', import.meta.url));
  await writeFile(join(source, 'browser.cjs'), `
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {chromium}=require(${JSON.stringify(playwrightModule)});
(async()=>{
 const child=spawn(process.execPath,['-e','require("node:http").createServer((q,r)=>r.end("<button id=run>run</button><div id=value>42</div>")).listen(0,"127.0.0.1",function(){console.log(this.address().port)})'],{stdio:['ignore','pipe','inherit']});
 const closed=new Promise(resolve=>child.once('exit',resolve));
 let browser;
 try{
  const port=await new Promise(resolve=>child.stdout.once('data',v=>resolve(Number(v.toString().trim()))));
  assert.match(await(await fetch('http://127.0.0.1:'+port)).text(),/42/);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+port);await page.locator('#run').click();
  assert.equal(await page.locator('#value').textContent(),'42');
  console.log('browser-http-proof:'+port);
 }finally{await browser?.close();child.kill('SIGTERM');await closed;}
})().catch(e=>{console.error(e);process.exitCode=1;});
`);
  await exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source });
  await git(source, ['init', '-b', 'main']); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'fixture baseline']);
  const baseline = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(source, 'user-only.txt'), 'keep dirty user tree');
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_MODE: 'development', MULTIVAC_FAKE_ASSISTANT: '0', MULTIVAC_PROVIDER: 'local-scripted', MULTIVAC_MODEL: 'scripted' });
  const runChecks = 'npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm test';
  const browser = `PLAYWRIGHT_BROWSERS_PATH=${quote(process.env.PLAYWRIGHT_BROWSERS_PATH ?? fileURLToPath(new URL('../../../.tmp/browsers', import.meta.url)))} ${quote(process.execPath)} browser.cjs`;
  const script = (task: boolean) => {
    model.script(
      { toolCalls: [{ name: 'bash', arguments: { command: runChecks } }] },
      { toolCalls: [{ name: 'edit', arguments: { path: 'value.cjs', edits: [{ oldText: 'exports.value = 1;', newText: 'exports.value = 42;' }] } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: `${runChecks} && ${browser}` } }] },
      ...(task ? [
        { toolCalls: [{ name: 'commit_task_code', arguments: { paths: ['value.cjs'], message: 'fix: 修复计算结果' } }] },
        { toolCalls: [{ name: 'write', arguments: { path: 'result.md', content: '已修复 value；npm ci/build/test 与真实 Chromium/HTTP 已验证。模型传输由本机脚本提供，外部真实模型尚未验证。' } }] },
        { toolCalls: [{ name: 'submit_task_result', arguments: { path: 'result.md', title: '受控开发闭环结果' } }] },
      ] : []),
      { text: '受控开发闭环已结束，等待服务端核对。' },
    );
  };
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const api = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const post = async (path: string, body: unknown): Promise<any> => {
      const response = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
    };
    const { project } = await post('/api/projects', { name: '受控执行对照', directory: source });
    await post('/api/sessions', { sessionId: 'parity-work', title: '工作会话对照', workspaceId: project.projectId });
    script(false);
    await post('/api/sessions/parity-work/turns', { commandId: 'work-development', assistantSessionId: 'parity-work', text: '执行受控开发闭环。', contextRefs: [] });
    const workResults = model.takeToolResults().join('\n');
    assert.match(workResults, /ERR_ASSERTION|Expected values/); assert.match(workResults, /browser-http-proof/);
    assert.equal(await readFile(join(source, 'value.cjs'), 'utf8'), 'exports.value = 42;\n');
    script(true);
    const task = app.tasks.create({ commandId: 'task', title: '任务对照', goal: '执行受控开发闭环并保存成果。', projectId: project.projectId, acceptance: true }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    for (let i = 0; i < 400; i++) {
      if (app.tasks.detail(task.taskId).runs?.[0]?.stopConfirmed) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const detail = app.tasks.detail(task.taskId), run = detail.runs![0]!;
    const taskResults = model.takeToolResults().join('\n');
    assert.match(taskResults, /ERR_ASSERTION|Expected values/); assert.match(taskResults, /browser-http-proof/);
    assert.equal(run.executionMode, 'workspace'); assert.equal(run.stopConfirmed, true); assert.deepEqual(run.nativePendingIds, []);
    assert.equal(detail.task.status, 'review', JSON.stringify(detail));
    assert.equal(run.directory!.kind, 'worktree'); assert.notEqual(run.directory!.path, source);
    assert.notEqual((await git(run.directory!.path, ['rev-parse', 'HEAD'])).stdout.trim(), baseline);
    assert.equal((await git(source, ['rev-parse', 'HEAD'])).stdout.trim(), baseline);
    assert.equal(await readFile(join(source, 'user-only.txt'), 'utf8'), 'keep dirty user tree');
    assert.ok(app.managedProcesses.list(true).filter(p => p.runId === run.runId).every(p => ['exited', 'failed'].includes(p.state)));
    assert.ok(run.outputBytes! > 0);
    const proofs = [...workResults.matchAll(/browser-http-proof:(\d+)/g), ...taskResults.matchAll(/browser-http-proof:(\d+)/g)];
    assert.ok(proofs.length >= 2);
    for (const proof of proofs) await assert.rejects(fetch(`http://127.0.0.1:${proof[1]}`));
  } finally {
    app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close(); await model.close(); await rm(root, { recursive: true, force: true });
  }
});
