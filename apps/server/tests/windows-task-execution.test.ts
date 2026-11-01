import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

test('Windows 任务准备失败后可继续，在独立 worktree 修改、提交并登记成果', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-win-task-execution-'));
  const source = join(root, 'source');
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) => execFileSync('git.exe', args, {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  git(root, 'init', '-b', 'main', source);
  await writeFile(join(source, 'value.txt'), 'baseline\n');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'windows-task-proof', version: '1.0.0', scripts: { test: 'node -e "process.exit(require(\'fs\').readFileSync(\'value.txt\',\'utf8\') === \'task result\\n\' ? 0 : 1)"' } }));
  await writeFile(join(source, 'package-lock.json'), JSON.stringify({ name: 'windows-task-proof', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'windows-task-proof', version: '1.0.0' } } }));
  git(source, 'add', 'value.txt', 'package.json', 'package-lock.json');
  git(source, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'baseline');
  const baseline = git(source, 'rev-parse', 'HEAD');
  await writeFile(join(source, 'user-only.txt'), 'dirty source\n');

  const model = await startScriptedModel();
  const data = testDataDir(root);
  await configureScriptedModel(join(data, 'pi'), model.endpoint);
  const app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_MODE: 'development', MULTIVAC_FAKE_ASSISTANT: '0', MULTIVAC_PROVIDER: 'local-scripted', MULTIVAC_MODEL: 'scripted' });
  try {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Windows 任务验收', directory: source }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const project = (await response.json() as { project: { projectId: string } }).project;
    const task = app.tasks.create({ commandId: 'task', title: '修改文件', goal: '修改并提交文件，登记成果。', projectId: project.projectId, acceptance: true }).task;
    const waitForStop = async (runId: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (app.tasks.detail(task.taskId).runs?.find(run => run.runId === runId)?.stopConfirmed) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail(`任务运行 ${runId} 未在时限内确认停止。`);
    };

    const hiddenSource = join(root, 'source-hidden');
    await rename(source, hiddenSource);
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    const firstRunId = app.tasks.get(task.taskId).currentRunId!;
    await waitForStop(firstRunId);
    assert.equal(app.tasks.get(task.taskId).status, 'failed');
    assert.equal(app.tasks.detail(task.taskId).runs?.find(run => run.runId === firstRunId)?.directory, null);
    await rename(hiddenSource, source);

    model.script(
      { toolCalls: [{ name: 'write', arguments: { path: 'value.txt', content: 'task result\n' } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'npm.cmd ci --ignore-scripts --offline --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm.cmd test; exit $LASTEXITCODE' } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'git.exe -c user.name=Multivac -c user.email=multivac@localhost add -- value.txt; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; git.exe -c user.name=Multivac -c user.email=multivac@localhost commit -m "fix: 保存任务结果" -- value.txt; exit $LASTEXITCODE' } }] },
      { toolCalls: [{ name: 'write', arguments: { path: 'result.md', content: 'Windows 任务结果已提交并核对。\n' } }] },
      { toolCalls: [{ name: 'submit_task_result', arguments: { path: 'result.md', title: 'Windows 任务结果' } }] },
      { text: '已完成任务并提交成果。' },
    );
    await app.taskExecution.control(task.taskId, { commandId: 'resume', revision: app.tasks.get(task.taskId).revision, action: 'resume' });
    const resumedRunId = app.tasks.get(task.taskId).currentRunId!;
    await waitForStop(resumedRunId);
    await app.taskExecution.idle();

    const detail = app.tasks.detail(task.taskId);
    const run = detail.runs?.find(item => item.runId === resumedRunId);
    const toolResults = model.takeToolResults().join('\n');
    assert.equal(run?.stopConfirmed, true, JSON.stringify(detail));
    assert.equal(run.directory?.kind, 'worktree');
    assert.equal(await readFile(join(run.directory.path, 'value.txt'), 'utf8'), 'task result\n', JSON.stringify({ detail, toolResults }));
    assert.equal(await readFile(join(source, 'value.txt'), 'utf8'), 'baseline\n');
    assert.equal(await readFile(join(source, 'user-only.txt'), 'utf8'), 'dirty source\n');
    assert.notEqual(git(run.directory.path, 'rev-parse', 'HEAD'), baseline);
    assert.equal(git(source, 'rev-parse', 'HEAD'), baseline);
    assert.equal(detail.task.status, 'review', JSON.stringify(detail));
    assert.match(toolResults, /1 passing|0 passing|npm.*test|file changed/u);
  } finally {
    await app.taskExecution.idle();
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise<void>(resolve => app.server.close(() => resolve()));
    await app.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
