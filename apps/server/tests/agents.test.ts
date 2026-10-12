import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID, type ModelSettingsSnapshot, type WorkbenchEvent } from '@multivac/contracts';
import { AgentService, AgentServiceError } from '../src/application/agent-service.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { PiModelSettingsCatalogFactory } from '../src/runtime/executors/pi-model-settings-catalog.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

function snapshot(): ModelSettingsSnapshot {
  const capabilities = { source: 'pi-catalog' as const, input: ['text' as const], contextWindow: 1000, maxOutputTokens: 100, reasoning: true, thinkingLevels: ['off' as const, 'low' as const, 'high' as const] };
  const profile = (profileId: string, displayName: string) => ({ profileId, displayName, provider: 'p', modelId: profileId, protocol: 'openai-responses' as const, endpoint: null, reasoning: 'auto' as const, capabilities });
  return {
    revision: 1, defaultProfileId: 'ready',
    profiles: [profile('ready', '可用模型'), profile('broken', '未认证模型')],
    availability: [
      { profileId: 'ready', authenticated: true, available: true, authenticationType: 'api_key', reason: null, message: null },
      { profileId: 'broken', authenticated: false, available: false, authenticationType: null, reason: 'AUTH_MISSING', message: '缺少认证。' },
    ],
  };
}

async function withService(run: (service: AgentService, context: { store: SqliteAssistantStore; models: { current: ModelSettingsSnapshot }; events: WorkbenchEvent[] }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agents-'));
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  const models = { current: snapshot() };
  const events: WorkbenchEvent[] = [];
  const bus = new WorkbenchEvents();
  bus.subscribe((event) => events.push(event));
  let id = 0;
  try {
    const service = new AgentService({ repository: store.agents, modelSettings: { getSnapshot: async () => models.current }, events: bus, newId: () => `agent-${++id}` });
    await run(service, { store, models, events });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
}

test('预置协调者与通用执行可以列出；协调者固定，不能修改或删除；通用执行可改不可删', async () => {
  await withService(async (service, { store }) => {
    const list = await service.list();
    assert.deepEqual(list.agents.map((agent) => [agent.agentId, agent.fixed]), [[COORDINATOR_AGENT_ID, true], [DEFAULT_AGENT_ID, false]]);
    assert.equal(list.modelStates[DEFAULT_AGENT_ID]!.status, 'default');
    await assert.rejects(service.update(COORDINATOR_AGENT_ID, { commandId: 'edit-coordinator', revision: 1, patch: { instructions: '改掉协调者' } }), /固定配置/);
    assert.throws(() => service.remove(COORDINATOR_AGENT_ID, { commandId: 'delete-coordinator', revision: 1 }), /固定配置/);
    assert.throws(() => service.requireExecutable(COORDINATOR_AGENT_ID), /不能用于执行/);
    const edited = await service.update(DEFAULT_AGENT_ID, { commandId: 'edit-general', revision: 1, patch: { instructions: '  结论和证据分开写。 ' } });
    assert.equal(edited.agent.instructions, '结论和证据分开写。');
    assert.throws(() => service.remove(DEFAULT_AGENT_ID, { commandId: 'delete-general', revision: edited.agent.revision }), /默认的执行智能体不能删除/);
    // 重新启动时只补缺失的预置记录，不覆盖用户的修改。
    const restarted = new AgentService({ repository: store.agents, modelSettings: { getSnapshot: async () => snapshot() } });
    assert.equal(restarted.get(DEFAULT_AGENT_ID).instructions, '结论和证据分开写。');
  });
});

test('新建、修改、删除走幂等命令；名称唯一（忽略大小写与首尾空白）；版本冲突与命令冲突明确报错', async () => {
  await withService(async (service, { events }) => {
    const input = { commandId: 'create-research', name: '研究', description: '调研与资料整理', modelProfileId: 'ready', thinkingLevel: 'high' as const, instructions: '保留来源。' };
    const created = await service.create(input);
    assert.deepEqual(await service.create(input), created);
    assert.equal(events.filter((event) => event.type === 'agent.changed').length, 1);
    await assert.rejects(service.create({ ...input, name: '另一个' }), (error: unknown) => error instanceof AgentServiceError && error.code === 'COMMAND_ID_CONFLICT');
    await assert.rejects(service.create({ commandId: 'dup', name: ' 研究 ' }), /已有名为「研究」/);
    await assert.rejects(service.create({ commandId: 'dup-default', name: '通用执行' }), /已有名为/);
    const renamed = await service.update(created.agent.agentId, { commandId: 'rename', revision: 1, patch: { name: 'Research' } });
    assert.equal(renamed.agent.revision, 2);
    await assert.rejects(service.create({ commandId: 'case', name: 'research' }), /已有名为「Research」/);
    await assert.rejects(service.update(created.agent.agentId, { commandId: 'stale', revision: 1, patch: { description: '旧版本' } }), (error: unknown) => error instanceof AgentServiceError && error.code === 'COMMAND_STATE_MISMATCH');
    const unchanged = await service.update(created.agent.agentId, { commandId: 'same', revision: 2, patch: { name: 'Research' } });
    assert.equal(unchanged.agent.revision, 2);
    const removed = service.remove(created.agent.agentId, { commandId: 'remove', revision: 2 });
    assert.deepEqual(service.remove(created.agent.agentId, { commandId: 'remove', revision: 2 }), removed);
    assert.throws(() => service.get(created.agent.agentId), /不存在/);
    assert.deepEqual(events.filter((event) => event.type === 'agent.changed').map((event) => event.type === 'agent.changed' && event.change), ['created', 'updated', 'deleted']);
  });
});

test('不可用、已删除的模型与不受支持的推理等级不能保存；已保存的引用失效后保留并显示待核对', async () => {
  await withService(async (service, { models }) => {
    await assert.rejects(service.create({ commandId: 'broken', name: '坏模型', modelProfileId: 'broken' }), /不能保存为智能体的模型：缺少认证/);
    await assert.rejects(service.create({ commandId: 'missing', name: '缺失', modelProfileId: 'gone' }), /已删除/);
    await assert.rejects(service.create({ commandId: 'level', name: '等级', modelProfileId: 'ready', thinkingLevel: 'xhigh' }), /不再支持推理等级/);
    await assert.rejects(service.create({ commandId: 'orphan-level', name: '只有等级', thinkingLevel: 'high' }), /同时选择模型/);
    const agent = (await service.create({ commandId: 'ok', name: '可用', modelProfileId: 'ready', thinkingLevel: 'low' })).agent;
    assert.equal((await service.list()).modelStates[agent.agentId]!.status, 'ready');

    models.current = { ...models.current, profiles: models.current.profiles.filter((profile) => profile.profileId !== 'ready') };
    const state = (await service.list()).modelStates[agent.agentId]!;
    assert.equal(state.status, 'review');
    assert.match(state.message!, /已删除/);
    assert.equal(service.get(agent.agentId).modelProfileId, 'ready');
    // 只改名称等其他字段不重新要求模型可用；改模型时必须选可用的。
    const renamed = await service.update(agent.agentId, { commandId: 'rename', revision: 1, patch: { name: '可用（改名）' } });
    assert.equal(renamed.agent.modelProfileId, 'ready');
    await assert.rejects(service.update(agent.agentId, { commandId: 'to-broken', revision: 2, patch: { modelProfileId: 'broken' } }), /缺少认证/);
    const followDefault = await service.update(agent.agentId, { commandId: 'to-default', revision: 2, patch: { modelProfileId: null, thinkingLevel: null } });
    assert.equal(followDefault.agent.modelProfileId, null);
  });
});

test('HTTP：列出、新建、修改与删除智能体，错误码与状态码一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agents-http-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const list = await call('GET', '/api/agents');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.agents.map((agent: { agentId: string }) => agent.agentId), [COORDINATOR_AGENT_ID, DEFAULT_AGENT_ID]);
    const created = await call('POST', '/api/agents', { commandId: 'http-create', name: '周报', modelProfileId: 'fixture-openai', instructions: '按模板写周报。' });
    assert.equal(created.status, 200);
    const agentId = created.body.agent.agentId as string;
    assert.equal((await call('GET', `/api/agents/${agentId}`)).body.modelState.status, 'ready');
    const unavailable = await call('POST', '/api/agents', { commandId: 'http-broken', name: '未认证', modelProfileId: 'fixture-missing-auth' });
    assert.equal(unavailable.status, 400);
    assert.equal(unavailable.body.error.code, 'INVALID_REQUEST');
    assert.equal((await call('PATCH', `/api/agents/${COORDINATOR_AGENT_ID}`, { commandId: 'http-coordinator', revision: 1, patch: { name: '改名' } })).status, 400);
    assert.equal((await call('PATCH', `/api/agents/${agentId}`, { commandId: 'http-stale', revision: 9, patch: { name: '周报2' } })).status, 409);
    assert.equal((await call('PATCH', `/api/agents/${agentId}`, { commandId: 'http-rename', revision: 1, patch: { name: '周报2' } })).body.agent.name, '周报2');
    assert.equal((await call('DELETE', `/api/agents/${agentId}`, { commandId: 'http-delete', revision: 2 })).status, 200);
    assert.equal((await call('GET', `/api/agents/${agentId}`)).status, 404);
    assert.equal((await call('POST', '/api/agents', { commandId: 'bad', name: '' })).status, 400);
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    app.close(); await rm(root, { recursive: true, force: true });
  }
});

test('真实 Pi 模型目录参与校验：已认证的目录模型可保存，缺少认证的模型被拒绝且待核对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-agents-real-catalog-'));
  const authPath = join(root, 'auth.json');
  await writeFile(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'offline-agent-catalog-key' } }), { mode: 0o600 });
  const store = new SqliteAssistantStore(join(root, 'db.sqlite'));
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'catalog.json'), allowModelNetwork: false });
    const openai = runtime.getModels('openai').find((model) => model.api === 'openai-responses' && model.reasoning)!;
    const anthropic = runtime.getModels('anthropic').find((model) => model.api === 'anthropic-messages')!;
    assert.ok(openai && anthropic);
    const settings = new ModelSettingsService({ load: async () => ({ revision: 0, defaultProfileId: null, commands: [], profiles: [
      { profileId: 'openai-real', displayName: 'OpenAI 目录模型', provider: 'openai', modelId: openai.id, protocol: 'openai-responses', endpoint: null },
      { profileId: 'anthropic-unauthenticated', displayName: 'Anthropic 未认证', provider: 'anthropic', modelId: anthropic.id, protocol: 'anthropic-messages', endpoint: null },
    ] }), save: async () => {} }, new PiModelSettingsCatalogFactory({ authPath, candidateRoot: join(root, 'candidates') }));
    const service = new AgentService({ repository: store.agents, modelSettings: settings });
    const levels = (await settings.getSnapshot()).profiles.find((profile) => profile.profileId === 'openai-real')!.capabilities!.thinkingLevels!;
    const level = levels.find((item) => item !== 'off')!;
    const saved = await service.create({ commandId: 'real-ok', name: '真实目录', modelProfileId: 'openai-real', thinkingLevel: level });
    assert.equal((await service.list()).modelStates[saved.agent.agentId]!.status, 'ready');
    await assert.rejects(service.create({ commandId: 'real-auth', name: '缺认证', modelProfileId: 'anthropic-unauthenticated' }), /不能保存为智能体的模型/);
    assert.equal((await service.modelState({ modelProfileId: 'anthropic-unauthenticated', thinkingLevel: null })).status, 'review');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
