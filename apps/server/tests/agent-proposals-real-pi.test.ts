import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
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

type ProposalView = {
  proposalId: string; kind: string; status: string; title: string; problem: string | null;
  preview: { name: string; modelName: string | null; thinkingLevel: string | null } | null;
  outcome: { summary: string; receipt?: { headline: string; actions: Array<{ kind: string; page?: string }> } } | null;
  reason: string | null;
};

test('真实 Pi：Multivac 提议新建智能体只出确认卡，确认后登记并带回执；模型不可用的卡确认时过期', { skip: process.platform !== 'darwin', timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agent-proposal-pi-'));
  const scripted = await startScriptedModel();
  const agentDir = join(root, 'pi-agent');
  await configureScriptedModel(agentDir, scripted.endpoint);
  await writeFile(join(testDataDir(root), 'model-settings.json'), JSON.stringify(modelSettings(scripted.endpoint)));

  const app = createMultivacApplication(testApplicationEnvironment(root), {
    coordinatorAdapter: new PiCoordinatorAdapter({ agentDir, sessionDir: join(root, 'pi-sessions'), taskProtectedPaths: [testDataDir(root)] }),
    modelSettingsCatalogFactory: new PiModelSettingsCatalogFactory({ authPath: join(agentDir, 'auth.json'), candidateRoot: join(root, 'candidates') }),
  });
  try {
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-multivac-window-id': 'window-a' }, body: JSON.stringify(body),
    });
    const proposals = async () => (await (await fetch(`${base}/api/assistant/proposals`)).json() as { proposals: ProposalView[] }).proposals;

    // 模型提议新建：只生成确认卡，智能体还没有登记，卡上写全配置与提议时的模型名。
    scripted.script({ toolCalls: [{ name: 'propose_create_agent', arguments: { name: '资料整理', modelProfileId: 'scripted-b', thinkingLevel: 'high', instructions: '保留来源。' } }] }, { text: '已提出确认卡。' });
    const turn = await post('/api/assistant/turns', { commandId: 'turn-propose', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '帮我建一个资料整理的智能体，先给我确认', contextRefs: [] });
    assert.equal((await turn.json() as { terminalOutcome: string }).terminalOutcome, 'succeeded');
    const card = (await proposals()).find((proposal) => proposal.kind === 'agent.create')!;
    assert.deepEqual(
      [card.status, card.title, card.problem, card.preview?.name, card.preview?.modelName, card.preview?.thinkingLevel],
      ['pending', '新建智能体「资料整理」', null, '资料整理', '脚本模型 B', 'high'],
    );
    assert.deepEqual((await app.agents.list()).agents.map((agent) => agent.name), ['Multivac（协调）', '通用执行']);

    // 用户确认：登记为智能体，回执带“设置 · 智能体”入口。
    const decided = await post(`/api/assistant/proposals/${card.proposalId}/decision`, { decision: 'confirm' });
    assert.equal(decided.status, 200, await decided.clone().text());
    const settled = (await proposals()).find((proposal) => proposal.proposalId === card.proposalId)!;
    assert.equal(settled.status, 'executed');
    assert.equal(settled.outcome?.summary, '已创建智能体「资料整理」，模型：脚本模型 B · high；可在新建任务时选用。');
    assert.deepEqual(settled.outcome?.receipt?.actions, [{ kind: 'open-management-page', page: 'agents' }]);
    const created = (await app.agents.list()).agents.find((agent) => agent.name === '资料整理')!;
    assert.deepEqual([created.modelProfileId, created.thinkingLevel, created.instructions], ['scripted-b', 'high', '保留来源。']);

    // 引用了不存在的模型配置：卡上写明原因；确认时重新核对不过，过期且不登记。
    scripted.script({ toolCalls: [{ name: 'propose_create_agent', arguments: { name: '临时助手', modelProfileId: 'gone', instructions: '' } }] }, { text: '已提出确认卡。' });
    await post('/api/assistant/turns', { commandId: 'turn-broken', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '再建一个临时助手', contextRefs: [] });
    const broken = (await proposals()).find((proposal) => proposal.title === '新建智能体「临时助手」')!;
    assert.equal(broken.problem, '不能保存为智能体的模型：引用的模型配置已删除，请重新选择模型。');
    const expired = await post(`/api/assistant/proposals/${broken.proposalId}/decision`, { decision: 'confirm' });
    assert.equal(expired.status, 200, await expired.clone().text());
    const after = (await proposals()).find((proposal) => proposal.proposalId === broken.proposalId)!;
    assert.deepEqual([after.status, after.reason], ['expired', '不能保存为智能体的模型：引用的模型配置已删除，请重新选择模型。']);
    assert.deepEqual((await app.agents.list()).agents.map((agent) => agent.name), ['Multivac（协调）', '通用执行', '资料整理']);

    // 取消：卡取消后什么都不建。
    scripted.script({ toolCalls: [{ name: 'propose_create_agent', arguments: { name: '不要的助手', modelProfileId: 'scripted-a' } }] }, { text: '已提出确认卡。' });
    await post('/api/assistant/turns', { commandId: 'turn-cancel', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '再建一个助手', contextRefs: [] });
    const cancelled = (await proposals()).find((proposal) => proposal.title === '新建智能体「不要的助手」')!;
    assert.equal((await post(`/api/assistant/proposals/${cancelled.proposalId}/decision`, { decision: 'cancel' })).status, 200);
    assert.equal((await proposals()).find((proposal) => proposal.proposalId === cancelled.proposalId)!.status, 'cancelled');
    assert.deepEqual((await app.agents.list()).agents.map((agent) => agent.name), ['Multivac（协调）', '通用执行', '资料整理']);
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close();
    await scripted.close();
    await rm(root, { recursive: true, force: true });
  }
});
