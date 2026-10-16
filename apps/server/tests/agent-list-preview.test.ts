import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_AGENT_ID, type CoordinatorRuntimeConfig, type ModelProfileInput } from '@multivac/contracts';
import { AgentService } from '../src/application/agent-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { previewWorkSessionAgent, resolveWorkSessionAgent } from '../src/application/work-session-agent.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';

const base: CoordinatorRuntimeConfig = {
  systemPrompt: '', authorizedContext: [], model: { provider: 'base', modelId: 'base', thinkingLevel: 'high' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 }, compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
};
const profiles: ModelProfileInput[] = [
  { profileId: 'configured', displayName: '模型默认低推理', provider: 'fake', modelId: 'reasoning', protocol: 'openai-responses', endpoint: null, defaultThinkingLevel: 'low' },
  { profileId: 'plain', displayName: '无推理模型', provider: 'fake', modelId: 'plain', protocol: 'openai-responses', endpoint: null, reasoning: 'disabled' },
];

async function fixture(run: (context: { agents: AgentService; settings: ModelSettingsService; inspections(): number; setAuthenticated(value: boolean): void }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agent-list-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  let inspections = 0;
  let authenticated = true;
  const factory = new FakeModelSettingsCatalogFactory(() => authenticated);
  const settings = new ModelSettingsService({
    load: async () => ({ revision: 0, commands: [], defaultProfileId: 'configured', profiles: structuredClone(profiles) }), save: async () => {},
  }, { create: async (...args) => {
    const catalog = await factory.create(args[0]);
    return { inspect: async profiles => { inspections++; return catalog.inspect(profiles); } };
  } });
  const agents = new AgentService({ repository: store.agents, modelSettings: settings,
    executionPreview: (agent, snapshot) => previewWorkSessionAgent(agent, snapshot, base.model) });
  try { await run({ agents, settings, inspections: () => inspections, setAuthenticated: value => { authenticated = value; } }); }
  finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('大量候选仍只检查一次模型目录；默认、显式等级与能力适配的预览和发送一致', async () => {
  await fixture(async ({ agents, settings, inspections }) => {
    for (let index = 0; index < 20; index++) {
      await agents.create({ commandId: `create-${index}`, name: `候选 ${index}`, modelProfileId: index % 2 ? 'plain' : 'configured', ...(index % 4 === 0 ? { thinkingLevel: 'high' as const } : {}) });
    }
    const before = inspections();
    const list = await agents.list();
    assert.equal(inspections() - before, 1);
    assert.equal(Object.keys(list.invocations!).length, 21);
    for (const agent of list.agents.filter(agent => !agent.fixed)) {
      const execution = await resolveWorkSessionAgent({ agentId: agent.agentId, agents, settings, base, conventions: { projectConstraints: '', agentsFile: null } });
      assert.deepEqual(list.invocations![agent.agentId]!.executor, execution.executor);
    }
    assert.equal(list.invocations![DEFAULT_AGENT_ID]!.executor!.thinkingLevel, 'low');
  });
});

test('列表不缓存认证结论；发送独立复核，失效默认不会回退基础模型', async () => {
  await fixture(async ({ agents, settings, inspections, setAuthenticated }) => {
    assert.ok((await agents.list()).invocations![DEFAULT_AGENT_ID]!.executor);
    setAuthenticated(false);
    const before = inspections();
    await assert.rejects(resolveWorkSessionAgent({ agentId: DEFAULT_AGENT_ID, agents, settings, base, conventions: { projectConstraints: '', agentsFile: null } }), /全局默认模型当前无法使用/);
    assert.ok(inspections() > before);
    const list = await agents.list();
    assert.equal(list.invocations![DEFAULT_AGENT_ID]!.executor, null);
    assert.match(list.invocations![DEFAULT_AGENT_ID]!.error!, /认证/);
  });
});

test('预览处理未设默认、快照故障、删除的模型和不受支持的推理等级', async () => {
  await fixture(async ({ agents, settings }) => {
    const agent = agents.get(DEFAULT_AGENT_ID);
    const snapshot = await settings.getSnapshot();
    assert.equal(previewWorkSessionAgent(agent, { ...snapshot, defaultProfileId: null }, base.model).modelName, 'base/base');
    assert.throws(() => previewWorkSessionAgent(agent, null, base.model), /暂时无法读取/);
    assert.throws(() => previewWorkSessionAgent(agent, { ...snapshot, defaultProfileId: 'deleted' }, base.model), /已删除/);
    assert.throws(() => previewWorkSessionAgent({ ...agent, modelProfileId: 'plain', thinkingLevel: 'high' }, snapshot, base.model), /不再支持/);
    const invalidDefault = { ...snapshot, profiles: snapshot.profiles.map(profile => ({ ...profile, defaultThinkingLevel: 'max' as const })) };
    assert.throws(() => previewWorkSessionAgent(agent, invalidDefault, base.model), /默认推理等级/);
    assert.equal(previewWorkSessionAgent({ ...agent, modelProfileId: 'configured', thinkingLevel: 'high' }, invalidDefault, base.model).thinkingLevel, 'high');
  });
});
