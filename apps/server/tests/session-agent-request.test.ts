import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { PiModelAccessBackend } from '../src/runtime/executors/pi-model-access-backend.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { testApplicationEnvironment, testDataDir } from './fixtures/test-environment.js';

// 真 Pi SDK + 本机脚本化模型：检查真实请求参数，不冒充外部生产模型验证。
test('工作会话本轮请求采用智能体配置，收尾与重启恢复原模型并共享历史', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-session-agent-request-'));
  const model = await startScriptedModel();
  const agentDir = join(root, 'pi-agent');
  await configureScriptedModel(agentDir, model.endpoint);
  await writeFile(join(testDataDir(root), 'model-settings.json'), JSON.stringify({ revision: 0, defaultProfileId: 'a', commands: [], profiles: [
    { profileId: 'a', displayName: '模型 A', provider: 'local-scripted', modelId: 'scripted', protocol: 'openai-completions', endpoint: model.endpoint, defaultThinkingLevel: 'off' },
    { profileId: 'b', displayName: '模型 B', provider: 'local-scripted', modelId: 'scripted-b', protocol: 'openai-completions', endpoint: model.endpoint, reasoning: 'enabled' },
  ] }));
  const directory = join(root, 'source'); await mkdir(directory);
  await writeFile(join(directory, 'AGENTS.md'), '仅修改用户明确要求的内容。');
  await writeFile(join(directory, 'evidence.txt'), '当前目录核对内容');
  const createApp = () => createMultivacApplication(testApplicationEnvironment(root), {
    coordinatorAdapter: new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'pi-sessions') }),
    modelSettingsCatalogFactory: new PiModelSettingsCatalogFactory({ authPath: join(agentDir, 'auth.json'), candidateRoot: join(root, 'candidates') }),
    modelAccessBackend: new PiModelAccessBackend({ authPath: join(agentDir, 'auth.json') }),
  });
  let app = createApp();
  const start = async () => {
    await app.ready;
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  };
  const close = async () => {
    app.server.closeAllConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    app.close();
  };
  try {
    let base = await start();
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const projectResponse = await post('/api/projects', { name: '工作会话测试', directory, defaultConstraints: '保持既有目录授权。' });
    assert.equal(projectResponse.status, 201);
    const { workspace } = await projectResponse.json() as { workspace: { workspaceId: string } };
    assert.equal((await post('/api/sessions', { sessionId: 'work', title: '本轮验证', workspaceId: workspace.workspaceId })).status, 201);
    const agent = (await app.agents.create({ commandId: 'agent', name: '风险审查', modelProfileId: 'b', thinkingLevel: 'high', instructions: '本轮特殊约定：先列风险再给结论。' })).agent;
    const selectionBefore = await (await fetch(base + '/api/sessions/work/model-selection')).json();
    model.script({ toolCalls: [{ name: 'read', arguments: { path: 'evidence.txt' } }] }, { text: '已检查当前目录。' });
    const selected = await post('/api/sessions/work/turns', { commandId: 'selected', assistantSessionId: 'work', text: '读取 evidence.txt 并检查风险。', contextRefs: [], agentId: agent.agentId });
    assert.equal(selected.status, 200, await selected.clone().text());
    const receipt = await selected.json() as { terminalOutcome: string; executor: { agentId: string; thinkingLevel: string } };
    assert.equal(receipt.terminalOutcome, 'succeeded');
    assert.equal(receipt.executor.agentId, agent.agentId);
    assert.equal(receipt.executor.thinkingLevel, 'high');
    const selectedRequests = model.takeRequests();
    assert.equal(selectedRequests.length, 2);
    for (const request of selectedRequests) {
      assert.equal(request.model, 'scripted-b'); assert.equal(request.reasoningEffort, 'high');
      assert.match(request.systemPrompt, /本轮特殊约定/);
      assert.match(request.systemPrompt, /保持既有目录授权/);
      assert.match(request.systemPrompt, /仅修改用户明确要求/);
      assert.ok(request.tools.includes('read'));
    }
    assert.match(model.takeToolResults().join('\n'), /当前目录核对内容/);
    const selectionAfter = await (await fetch(base + '/api/sessions/work/model-selection')).json();
    assert.deepEqual(selectionAfter.selection, selectionBefore.selection);
    // 在普通模型产生下一条回复之前重启，确保收尾记录本身足以恢复原选择。
    await close();
    app = createApp();
    base = await start();
    const reopened = await (await fetch(base + '/api/sessions/work/model-selection')).json();
    assert.deepEqual(reopened.selection, selectionBefore.selection);
    model.script({ text: '仍可使用之前的对话上下文。' });
    const plain = await post('/api/sessions/work/turns', { commandId: 'plain', assistantSessionId: 'work', text: '回顾刚才的目录内容，普通正文 @风险审查。', contextRefs: [] });
    assert.equal(plain.status, 200);
    const [request] = model.takeRequests(); assert.ok(request);
    assert.equal(request.model, 'scripted'); assert.doesNotMatch(request.systemPrompt, /本轮特殊约定/);
    assert.ok(request.userTexts.some(text => text.includes('读取 evidence.txt')));
    assert.deepEqual(request.tools.sort(), selectedRequests[0]!.tools.sort());
    const history = await (await fetch(base + '/api/sessions/work/session?limit=100')).json() as { messages: { text: string }[]; commandAnchors: { executor?: { name: string } }[] };
    assert.ok(history.messages.some(message => message.text === '已检查当前目录。'));
    assert.ok(history.commandAnchors.some(anchor => anchor.executor?.name === '风险审查'));
    assert.equal((await post('/api/assistant/turns', { commandId: 'global-denied', assistantSessionId: 'global-coordinator', text: '不能调用', contextRefs: [], agentId: agent.agentId })).status, 400);
  } finally {
    await close(); await model.close(); await rm(root, { recursive: true, force: true });
  }
});
