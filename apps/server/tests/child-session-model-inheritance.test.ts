import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Check } from 'typebox/value';
import {
  CreateWorkspaceSessionSchema, WorkspaceSessionSchema,
  type CoordinatorModelConfig, type CoordinatorRuntimeConfig,
} from '@multivac/contracts';
import { createWorkspaceSessionRequestHandler } from '../src/adapters/http/workspace-session-routes.js';
import { ProjectService } from '../src/application/project-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionRuntime } from '../src/application/assistant-session-runtime.js';
import { ModelSettingsService } from '../src/application/model-settings-service.js';
import { createNewSessionRuntimeConfigResolver } from '../src/application/new-session-runtime-config.js';
import { SessionRuntimeRegistry } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkspaceSessionService } from '../src/application/workspace-session-service.js';
import { InternalToolService, type InternalToolServices } from '../src/application/internal-tools/internal-tool-service.js';
import { createSessionTool, sessionIdForCommand } from '../src/application/internal-tools/session-tools.js';
import { internalToolCommandId } from '../src/modules/internal-tools/internal-tool.js';
import type { StoredModelSettingsState } from '../src/modules/model-settings/model-settings.js';
import type { CreateCoordinatorSessionInput } from '../src/runtime/executors/coordinator-adapter.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { FakeModelSettingsCatalogFactory } from '../src/runtime/executors/fake-model-settings-catalog.js';
import {
  SqliteAssistantStore, SqliteAssistantBindingRepository, SqliteAssistantPageStateRepository,
  SqliteAssistantCommandRepository, SqliteAssistantEventRepository, SqliteInternalToolCallRepository,
  SqliteSessionRegistryRepository, SqliteSessionSelectionRepository, SqliteWorkspaceRepository, SqliteProjectRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

const config: CoordinatorRuntimeConfig = {
  systemPrompt: 'Multivac', authorizedContext: [],
  model: { source: 'base', provider: 'base', modelId: 'base-model', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 2000 },
};
const initial: StoredModelSettingsState = {
  revision: 0, defaultProfileId: 'gpt', commands: [], profiles: [
    { profileId: 'gpt', displayName: 'GPT', provider: 'fixture', modelId: 'gpt-fixture', protocol: 'openai-responses', endpoint: 'https://fixture.example/v1' },
    { profileId: 'claude', displayName: 'Claude', provider: 'fixture-anthropic', modelId: 'claude-fixture', protocol: 'anthropic-messages', endpoint: 'https://anthropic.fixture.example', defaultThinkingLevel: 'low' },
  ],
};

function harness(root: string, state = structuredClone(initial), suppliedAdapter?: FakeCoordinatorAdapter) {
  const piDir = join(root, 'pi');
  mkdirSync(piDir, { recursive: true });
  const adapter = suppliedAdapter ?? new FakeCoordinatorAdapter({ sessionPathRoot: piDir, persistSessionModels: true, seedsHistory: () => false });
  const store = new SqliteAssistantStore(join(root, 'data.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const workspaces = new SqliteWorkspaceRepository(store);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), testDataDir(root));
  const directories = new SessionWorkingDirectories(workPaths, registry, testDataDir(root));
  const projects = new ProjectService({ projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir: testDataDir(root), homeDir: root });
  directories.prepareOnStartup();
  let authenticated = true;
  const settings = new ModelSettingsService({ load: async () => structuredClone(state), save: async next => { state = structuredClone(next); } },
    new FakeModelSettingsCatalogFactory(() => authenticated));
  const events = new AssistantEventStream();
  const dependencies = {
    adapter, modelSettingsService: settings, eventStream: events,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    commandRepository: new SqliteAssistantCommandRepository(store),
    eventRepository: new SqliteAssistantEventRepository(store),
    selectionRepository: new SqliteSessionSelectionRepository(store),
  };
  const runtimes = new SessionRuntimeRegistry<AssistantSessionRuntime>(record => new AssistantSessionRuntime(dependencies, {
    sessionId: record.sessionId, kind: 'work', runtimeConfig: config, sessionDir: piDir,
    ...(record.initialModel ? { initialModel: record.initialModel } : {}),
    resolveWorkingDirectory: () => directories.resolveForRuntime(record.sessionId),
    resolveNewSessionRuntimeConfig: createNewSessionRuntimeConfigResolver(settings, config, record.initialModel),
  }));
  const service = new WorkspaceSessionService({
    repository: registry, workingDirectories: directories, workspaces, runtimes,
    pageStateRepository: dependencies.pageStateRepository,
    readSessionModel: record => runtimes.acquire(record).selection.snapshotForChild(),
    readSessionHistory: async record => {
      await runtimes.acquire(record).initialize();
      const history = adapter.readActiveBranch(record.sessionId);
      if (!history.ok) throw new Error(history.error.message);
      return history.value;
    },
  });
  // 通过真实内部工具注册表调用 create_session，验证幂等与错误正文；其余能力在本组用例中不调用。
  const services: InternalToolServices = {
    sessions: service,
    projects,
    transcripts: { readMessages: () => { throw new Error('unused'); } },
    windows: { isOpen: () => false, navigate: () => false },
  };
  const tools = new InternalToolService({ tools: [createSessionTool], services,
    calls: new SqliteInternalToolCallRepository(store), currentTurn: () => ({ commandId: 'turn', windowId: null }) });
  const runtime = (id: string) => runtimes.acquire(service.resolve(id));
  return { store, registry, settings, service, adapter, tools, runtime, projects,
    auth: (value: boolean) => { authenticated = value; },
    close: () => { runtimes.releaseAll(); events.clear(); adapter.dispose(); store.close(); },
  };
}

async function choose(h: ReturnType<typeof harness>, id: string, profileId: string, level?: CoordinatorModelConfig['thinkingLevel']) {
  const selection = h.runtime(id).selection;
  let options = await selection.getOptions();
  const result = await selection.setModel({ commandId: `model:${id}:${options.selection.revision}`, sessionId: id, revision: options.selection.revision, profileId });
  assert.equal(result.status, 'succeeded');
  if (level !== undefined) {
    options = await selection.getOptions();
    const thinking = await selection.setThinkingLevel({ commandId: `thinking:${id}:${options.selection.revision}`, sessionId: id, revision: options.selection.revision, thinkingLevel: level });
    assert.equal(thinking.status, 'succeeded');
  }
}
async function parent(h: ReturnType<typeof harness>) {
  await h.service.create({ sessionId: 'parent', title: '父会话' });
  await choose(h, 'parent', 'claude', 'high');
}
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-child-model-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// 界面使用的请求契约带消息选区，内部工具只有 parentSessionId，两条路径最终都由公共服务冻结模型。
test('界面选区与内部工具均继承父模型及实际等级，显示、账本、Pi 与发送一致', () => temporary(async root => {
  const h = harness(root);
  try {
    await parent(h);
    h.adapter.appendAssistantHistoryForTest('parent', '用于深入的消息', 'entry-child-origin');
    const history = h.adapter.readActiveBranch('parent');
    assert.ok(history.ok);
    const input = { sessionId: 'ui-child', title: '界面子会话', parent: { sessionId: 'parent', quote: {
      sourcePiSessionId: history.value.piSessionId, sourcePiEntryId: 'entry-child-origin', sourceRole: 'assistant' as const, text: '用于深入的消息',
    } } };
    assert.equal(Check(CreateWorkspaceSessionSchema, input), true);
    // 直接驱动 HTTP handler 的内存请求，不监听端口、不访问网络。
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    request.url = '/api/sessions'; request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    request.push(JSON.stringify(input)); request.push(null);
    let status = 0; let responseBody = '';
    const response = { destroyed: false, writableEnded: false,
      writeHead: (value: number) => { status = value; }, end: (value: string) => { responseBody = value; },
    } as unknown as ServerResponse;
    try { assert.equal(await createWorkspaceSessionRequestHandler(h.service, h.projects)(request, response), true); }
    finally { socket.destroy(); }
    assert.equal(status, 201, responseBody);
    const ui: unknown = JSON.parse(responseBody);
    assert.equal(Check(WorkspaceSessionSchema, ui), true);
    assert.ok(ui && typeof ui === 'object');
    assert.equal('initialModel' in ui, false);
    const call = { assistantSessionId: 'global-coordinator', toolName: 'create_session', toolCallId: 'child-tool', args: { title: '工具子会话', parentSessionId: 'parent' } };
    const tool = await h.tools.invoke(call, new AbortController().signal);
    assert.ok(tool.ok, tool.ok ? '' : tool.reason);
    const toolId = sessionIdForCommand(internalToolCommandId('global-coordinator', 'child-tool'));
    for (const id of ['ui-child', toolId]) {
      const options = await h.runtime(id).selection.getOptions();
      assert.equal(options.selection.profileId, 'claude');
      assert.equal(options.selection.thinkingLevel, 'high');
      assert.equal(options.selection.availability.available, true);
      assert.equal(h.store.getSelection(id)?.model.thinkingLevel, 'high');
      const actual = h.adapter.readModelSelection(id);
      assert.ok(actual.ok);
      assert.equal(actual.value.model.modelId, 'claude-fixture');
      assert.equal(actual.value.model.thinkingLevel, 'high');
      await h.runtime(id).commands.send({ commandId: `send:${id}`, assistantSessionId: id, text: '核对继承模型', contextRefs: [] });
      assert.ok(h.adapter.calls.some(entry => entry.method === 'prompt' && entry.assistantSessionId === id));
    }
    const count = h.adapter.calls.filter(call => call.method === 'createSession').length;
    assert.deepEqual(await h.tools.invoke(call, new AbortController().signal), tool);
    assert.equal(h.adapter.calls.filter(call => call.method === 'createSession').length, count);
    assert.equal((await h.runtime('parent').selection.getOptions()).selection.profileId, 'claude');
  } finally { h.close(); }
}));

test('父子与孙会话后续切换独立；顶层仍使用全局默认', () => temporary(async root => {
  const h = harness(root);
  try {
    await parent(h);
    await h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } });
    await choose(h, 'parent', 'gpt');
    assert.equal((await h.runtime('child').selection.getOptions()).selection.thinkingLevel, 'high');
    await choose(h, 'child', 'claude', 'medium');
    await h.service.create({ sessionId: 'grandchild', title: '孙会话', parent: { sessionId: 'child' } });
    await choose(h, 'child', 'gpt');
    assert.equal((await h.runtime('grandchild').selection.getOptions()).selection.thinkingLevel, 'medium');
    assert.equal((await h.runtime('parent').selection.getOptions()).selection.profileId, 'gpt');
    assert.equal(h.registry.get('child')?.initialModel?.thinkingLevel, 'high');
    await h.service.create({ sessionId: 'top', title: '顶层会话' });
    assert.equal(h.registry.get('top')?.initialModel, undefined);
    assert.equal((await h.runtime('top').selection.getOptions()).selection.profileId, 'gpt');
  } finally { h.close(); }
}));

class UnavailableChildAdapter extends FakeCoordinatorAdapter {
  override async createSession(input: CreateCoordinatorSessionInput) {
    if (input.assistantSessionId === 'child') return { ok: false as const, error: { code: 'MODEL_AUTH_UNAVAILABLE' as const, message: 'fixture outage' } };
    return super.createSession(input);
  }
}

test('未绑定子会话重启后首次访问仍采用创建快照，不消费变化后的默认及模型默认等级', () => temporary(async root => {
  let h = harness(root, structuredClone(initial), new UnavailableChildAdapter({ persistSessionModels: true, seedsHistory: () => false }));
  try {
    await parent(h);
    await assert.rejects(h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } }), /继承的父会话模型/u);
    const snapshot = h.registry.get('child')?.initialModel;
    assert.ok(snapshot);
    assert.equal(h.store.getBinding('child'), undefined);
    h.close();
    const changed = structuredClone(initial);
    changed.defaultProfileId = 'claude';
    changed.profiles[1]!.defaultThinkingLevel = 'max';
    h = harness(root, changed);
    await h.runtime('child').initialize();
    assert.equal((await h.runtime('child').selection.getOptions()).selection.thinkingLevel, 'high');
    assert.deepEqual(h.registry.get('child')?.initialModel, snapshot);
    assert.equal(h.adapter.calls.some(call => call.method === 'createSession' && call.input.assistantSessionId === 'parent'), false);
  } finally { h.close(); }
}));

for (const failure of ['removed', 'auth', 'endpoint'] as const) test(`继承配置 ${failure} 失效时保留快照并给出原因，不创建默认模型`, () => temporary(async root => {
  const h = harness(root, structuredClone(initial), new UnavailableChildAdapter({ persistSessionModels: true, seedsHistory: () => false }));
  try {
    await parent(h);
    const input = { sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } };
    await assert.rejects(h.service.create(input));
    const snapshot = h.registry.get('child')?.initialModel;
    const state = structuredClone(initial);
    if (failure === 'removed') state.profiles = state.profiles.filter(profile => profile.profileId !== 'claude');
    if (failure === 'endpoint') state.profiles[1]!.endpoint = 'https://changed.example';
    if (failure === 'auth') h.auth(false);
    await h.settings.replaceStateForTest(state);
    await assert.rejects(h.service.create(input), /继承的父会话模型.*不会自动切换全局默认模型/u);
    assert.deepEqual(h.registry.get('child')?.initialModel, snapshot);
    assert.equal(h.store.getBinding('child'), undefined);
    assert.equal(h.adapter.calls.some(call => call.method === 'createSession' && call.input.assistantSessionId === 'child'), false);
  } finally { h.close(); }
}));

test('Pi 把继承等级归一化时核对实际值并明确拒绝，不把初始化意图当作执行证明', () => temporary(async root => {
  class NormalizingAdapter extends FakeCoordinatorAdapter {
    override async createSession(input: CreateCoordinatorSessionInput) {
      const result = await super.createSession(input);
      if (input.assistantSessionId === 'child') await this.setThinkingLevel('child', 'off');
      return result;
    }
  }
  const h = harness(root, structuredClone(initial), new NormalizingAdapter({ persistSessionModels: true, seedsHistory: () => false }));
  try {
    await parent(h);
    await assert.rejects(h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } }), /请求.*high.*Pi 返回.*off/u);
    assert.equal(h.store.getBinding('child'), undefined);
    assert.equal(h.registry.get('child')?.initialModel?.thinkingLevel, 'high');
  } finally { h.close(); }
}));

test('基础模型也继承父会话选择；后设全局默认不覆盖子会话，子选择恢复优先于初始化快照', () => temporary(async root => {
  const state = structuredClone(initial);
  state.defaultProfileId = null;
  const h = harness(root, state);
  try {
    await h.service.create({ sessionId: 'parent', title: '基础模型父会话' });
    await h.settings.replaceStateForTest(structuredClone(initial));
    await h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } });
    assert.equal((await h.runtime('child').selection.getOptions()).selection.source, 'base');
    await choose(h, 'child', 'claude', 'medium');
    h.service.archive('child');
    h.service.restore('child');
    assert.equal((await h.runtime('child').selection.getOptions()).selection.thinkingLevel, 'medium');
    assert.equal(h.registry.get('child')?.initialModel?.source, 'base');
  } finally { h.close(); }
}));

test('未安全对账的父选择拒绝创建，不保存错误的继承快照', () => temporary(async root => {
  const h = harness(root);
  try {
    await parent(h);
    const selection = h.store.getSelection('parent')!;
    h.store.saveSelection({ ...selection, recoveryError: '需要人工恢复核对' });
    await assert.rejects(h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } }), /无法继承父会话模型/u);
    assert.equal(h.registry.get('child'), undefined);
  } finally { h.close(); }
}));

test('父会话切模型与深入并发时，快照等待同一互斥区并读取切换后的实际选择', () => temporary(async root => {
  let entered!: () => void; let release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const releasing = new Promise<void>(resolve => { release = resolve; });
  class SlowAdapter extends FakeCoordinatorAdapter {
    override async setModel(id: string, model: CoordinatorModelConfig) {
      if (id === 'parent') { entered(); await releasing; }
      return super.setModel(id, model);
    }
  }
  const h = harness(root, structuredClone(initial), new SlowAdapter({ persistSessionModels: true, seedsHistory: () => false }));
  try {
    await h.service.create({ sessionId: 'parent', title: '父会话' });
    const change = h.runtime('parent').selection.setModel({ commandId: 'slow-model', sessionId: 'parent', revision: 0, profileId: 'claude' });
    await entering;
    const creation = h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } });
    assert.equal(h.registry.get('child'), undefined);
    release();
    assert.equal((await change).status, 'succeeded');
    await creation;
    assert.equal((await h.runtime('child').selection.getOptions()).selection.profileId, 'claude');
    assert.equal(h.registry.get('child')?.initialModel?.thinkingLevel, 'low');
  } finally { release(); h.close(); }
}));

test('已绑定子会话重启按自己的选择恢复，初始化快照及新默认均不覆盖后续切换', () => temporary(async root => {
  let h = harness(root);
  try {
    await parent(h);
    await h.service.create({ sessionId: 'child', title: '子会话', parent: { sessionId: 'parent' } });
    await choose(h, 'child', 'gpt');
    const snapshot = h.registry.get('child')?.initialModel;
    h.close();
    const changed = structuredClone(initial); changed.defaultProfileId = 'claude';
    h = harness(root, changed);
    const options = await h.runtime('child').selection.getOptions();
    assert.equal(options.selection.profileId, 'gpt');
    assert.equal(options.selection.thinkingLevel, 'off');
    assert.deepEqual(h.registry.get('child')?.initialModel, snapshot);
    assert.equal(h.adapter.calls.some(call => call.method === 'createSession'), false);
    assert.ok(h.adapter.calls.some(call => call.method === 'continueSession' && call.input.binding.assistantSessionId === 'child'));
  } finally { h.close(); }
}));

test('快照列迁移可重放且旧顶层无继承值；损坏快照拒绝读出而不回退默认', () => temporary(async root => {
  const path = join(root, 'migration.sqlite');
  let store = new SqliteAssistantStore(path);
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)');
  raw.close();
  store = new SqliteAssistantStore(path);
  try {
    assert.equal(store.getSession('global-coordinator')?.initialModel, undefined);
    store.insertSessionIfAbsent({ sessionId: 'child', title: '子会话', kind: 'work', workspaceId: 'default', createdAt: '2026-10-06T00:00:00.000Z', parentSessionId: 'parent', initialModel: config.model, workingDirectory: { kind: 'session-temp', path: join(root, 'child') } });
  } finally { store.close(); }
  const corrupt = new DatabaseSync(path);
  corrupt.prepare('UPDATE assistant_session_registry SET initial_model_json = ? WHERE session_id = ?').run('{broken', 'child');
  corrupt.close();
  store = new SqliteAssistantStore(path);
  try { assert.throws(() => store.getSession('child'), /继承的模型快照损坏/u); } finally { store.close(); }
}));
