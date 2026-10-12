import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { configureScriptedModel, startScriptedModel, type ScriptedModelRequest } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

/** 两个指向本机脚本化模型的受控配置：默认的 scripted，以及开启推理的 scripted-b。 */
function modelSettings(endpoint: string) {
  return {
    revision: 0,
    profiles: [
      { profileId: 'scripted-a', displayName: '脚本模型 A', provider: 'local-scripted', modelId: 'scripted', protocol: 'openai-completions', endpoint },
      { profileId: 'scripted-b', displayName: '脚本模型 B', provider: 'local-scripted', modelId: 'scripted-b', protocol: 'openai-completions', endpoint, reasoning: 'enabled' },
    ],
    defaultProfileId: 'scripted-a',
    commands: [],
  };
}

async function firstRequest(take: () => ScriptedModelRequest[]): Promise<ScriptedModelRequest> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [request] = take();
    if (request) return request;
    await delay(100);
  }
  throw new Error('任务执行会话没有向模型发出请求。');
}

test('真实 Pi：任务执行会话按智能体选模型与推理等级，系统提示并列注入智能体指令、项目默认约束与 AGENTS.md', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-task-agent-pi-'));
  const model = await startScriptedModel();
  const agentDir = join(root, 'pi-agent');
  await configureScriptedModel(agentDir, model.endpoint);
  await writeFile(join(testDataDir(root), 'model-settings.json'), JSON.stringify(modelSettings(model.endpoint)));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), '# 仓库约定\n提交前运行 npm test。\n');
  await writeFile(join(source, 'README.md'), '站点说明\n');

  const app = createMultivacApplication(testApplicationEnvironment(root), {
    coordinatorAdapter: new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'pi-sessions'), taskProtectedPaths: [testDataDir(root)] }),
    modelSettingsCatalogFactory: new PiModelSettingsCatalogFactory({ authPath: join(agentDir, 'auth.json'), candidateRoot: join(root, 'candidates') }),
  });
  try {
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '站点', directory: source, defaultConstraints: '只改 docs 目录。' }),
    });
    const project = (await response.json() as { project: { projectId: string } }).project;
    const reviewer = (await app.agents.create({
      commandId: 'agent', name: '代码审查', modelProfileId: 'scripted-b', thinkingLevel: 'high', instructions: '先列出风险，再给结论。',
    })).agent;

    model.script({ text: '已按执行约定开始审查。' });
    const task = app.tasks.create({ commandId: 'task', title: '审查改动', goal: '审查站点改动', projectId: project.projectId, agentId: reviewer.agentId }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    const request = await firstRequest(model.takeRequests);

    assert.equal(request.model, 'scripted-b');
    assert.equal(request.reasoningEffort, 'high');
    const parts = ['## 本任务的执行约定', '### 执行智能体「代码审查」的指令\n先列出风险，再给结论。', '### 项目默认约束\n只改 docs 目录。', '### 工作目录的 AGENTS.md\n# 仓库约定\n提交前运行 npm test。'];
    const positions = parts.map((part) => request.systemPrompt.indexOf(part));
    assert.ok(positions.every((position) => position >= 0), request.systemPrompt);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.equal(app.tasks.detail(task.taskId).runs?.[0]?.agentId, reviewer.agentId);

    // 通用执行跟随全局默认模型，指令为空时不出现智能体指令一节。
    model.script({ text: '已开始整理。' });
    const plain = app.tasks.create({ commandId: 'plain', title: '整理笔记', goal: '整理日常笔记' }).task;
    await app.taskExecution.control(plain.taskId, { commandId: 'start-plain', revision: plain.revision, action: 'start' });
    const plainRequest = await firstRequest(model.takeRequests);
    assert.equal(plainRequest.model, 'scripted');
    assert.doesNotMatch(plainRequest.systemPrompt, /执行智能体「/);
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
