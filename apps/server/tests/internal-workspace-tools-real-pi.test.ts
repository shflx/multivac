import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorAdapterEvent,
  type CoordinatorRuntimeConfig,
  type CurrentViewSnapshot,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import {
  InternalToolService,
  MULTIVAC_INTERNAL_TOOLS,
  type InternalToolServices,
} from '../src/application/internal-tools/index.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionTranscriptReader } from '../src/application/session-transcripts.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { WorkspaceSessionService } from '../src/application/workspace-session-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteTempDirectoryCleanupRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 真实 Pi 下的工作区操作工具：Pi SDK、customTools 注入、目录边界扩展、SQLite、会话服务、工作台事件与账本全部真实运行，
 * 模型换成本机脚本。全局 Multivac 在一轮中“切到研究项目，并排数调到 3，把 R1 放到第一栏，再打开模型设置”：
 * 现场按界面同一套规则保存并推给各窗口，切换页面只推给发起窗口；本轮后面的工具以切换后的界面为准。
 * 发起窗口关闭后，改现场的工具只更新保存的现场并如实说明，只切页面的工具失败。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 的全局助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

test('真实 Pi：对话中切换工作区、调整并排数、放进栏位与打开管理页；只切换发起窗口，其他窗口只同步现场', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-workspace-tools-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  const agentDir = join(dataDir, 'pi-agent');
  await configureScriptedModel(agentDir, model.endpoint);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });

  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const bindings = new SqliteAssistantBindingRepository(store);
  const pageStates = new SqliteAssistantPageStateRepository(store);
  const workspaces = new SqliteWorkspaceRepository(store);
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir, {
    plans: new SqliteTempDirectoryCleanupRepository(store),
  });
  directories.prepareOnStartup();
  const authorizations: string[] = [];
  const adapter = new PiCoordinatorAdapter({
    agentDir,
    sessionDir: join(dataDir, 'pi-sessions'),
    authorizeToolCall: async (request) => {
      authorizations.push(request.toolName);
      return { allowed: false, reason: '测试中不批准。' };
    },
  });
  const runtimes = new SessionRuntimeRegistry<SessionRuntime>((record) => ({
    sessionId: record.sessionId,
    initialize: async () => undefined,
    isRunning: () => false,
    dispose: () => undefined,
  }));
  const events = new WorkbenchEvents();
  // 两个窗口按推送通道的规则收事件：广播都收，定向的只有目标窗口收。
  const inbox: Record<string, WorkbenchEvent[]> = { 'window-a': [], 'window-b': [] };
  const connect = (windowId: string) => events.subscribe((event, delivery) => {
    if (delivery.targetWindowId === undefined || delivery.targetWindowId === windowId) inbox[windowId]!.push(event);
  }, windowId);
  const disconnectA = connect('window-a');
  connect('window-b');
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store), pageStateRepository: pageStates, events,
  });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
  });
  const research = projects.createProject({ name: '研究项目' }).project;
  const ids: string[] = [];
  for (const title of ['R1', 'R2', 'R3']) {
    ids.push((await sessions.create({ sessionId: `r-${ids.length + 1}`, title, workspaceId: research.projectId })).session.sessionId);
  }
  const [r1, r2, r3] = ids as [string, string, string];

  const windows: InternalToolServices['windows'] = {
    navigate: (windowId, target, origin) => events.publishToWindow(windowId, { type: 'window.navigate', origin, target }),
    isOpen: (windowId) => events.hasWindow(windowId),
  };
  // 这一轮由窗口 window-a 从首页发出，发送时它的当前工作区是默认工作区；导航后由工具更新视图。
  let view: CurrentViewSnapshot = {
    panel: 'home', narrow: false, workspace: { workspaceId: 'default', scene: null }, management: null,
  };
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: { projects, sessions, transcripts: new SessionTranscriptReader({ registry, bindings, adapter }), windows },
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => ({ commandId: 'turn-1', windowId: 'window-a', view, updateView: (next) => { view = next; } }),
  });
  const ended: Array<Extract<CoordinatorAdapterEvent, { type: 'coordinator.tool.ended' }>> = [];
  const prompt = async (text: string, ...steps: ScriptedStep[]) => {
    model.script(...steps, { text: `${text}：完成。` });
    const run = await adapter.prompt(GLOBAL_ASSISTANT_SESSION_ID, text);
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    return model.takeToolResults();
  };
  const navigations = (windowId: string) =>
    inbox[windowId]!.flatMap((event) => event.type === 'window.navigate' ? [event.target] : []);

  try {
    await new AssistantSessionService({
      adapter, bindingRepository: bindings, pageStateRepository: pageStates, runtimeConfig: config,
      resolveWorkingDirectory: () => directories.resolveForRuntime(GLOBAL_ASSISTANT_SESSION_ID),
      kind: 'coordinator', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, internalTools: service,
    }).initialize();
    assert.equal(adapter.subscribe(GLOBAL_ASSISTANT_SESSION_ID, (event) => {
      if (event.type === 'coordinator.tool.ended') ended.push(event);
    }).ok, true);

    // 请求声明了工作区工具；系统提示词写明只在用户明确要求“打开 / 切到 / 放到”时调用。
    const results = await prompt('切到研究项目，并排调到 3，把 R1 放到第一栏，再打开模型设置',
      { toolCalls: [{ name: 'switch_workspace', arguments: { workspaceId: research.projectId } }] },
      { toolCalls: [{ name: 'set_parallel_count', arguments: { count: 3 } }] },
      { toolCalls: [{ name: 'open_session', arguments: { sessionId: r1, slot: 1 } }] },
      { toolCalls: [{ name: 'open_management_page', arguments: { page: 'models' } }] });
    const [request] = model.takeRequests();
    for (const name of ['switch_workspace', 'open_session', 'set_parallel_count', 'set_view_mode', 'open_management_page']) {
      assert.ok(request!.tools.includes(name), `请求中应声明 ${name}`);
    }
    assert.match(request!.systemPrompt, /会改变用户界面的工具（[^）]*switch_workspace[^）]*）只在用户明确要求“打开 \/ 切到 \/ 放到”/u);

    // 各工具的正文与回执：并排数与放进栏位落在切换后的研究项目上（不是发送时快照里的默认工作区）。
    assert.match(results[0]!, /已把发起这条消息的窗口切到工作区 \[研究项目\]/u);
    assert.match(results[1]!, /已把工作区 \[研究项目\]\(multivac:\/\/workspace\/[^)]+\) 调为并排 3 栏/u);
    assert.match(results[2]!, /放到工作区 \[研究项目\]\(multivac:\/\/workspace\/[^)]+\) 的第 1 栏/u);
    assert.match(results[3]!, /已在发起这条消息的窗口中打开设置 · 模型。其他窗口没有被切换。/u);
    assert.deepEqual(ended.map((event) => [event.toolName, event.isError, event.result?.receipt?.headline]), [
      ['switch_workspace', false, '已切到工作区「研究项目」'],
      ['set_parallel_count', false, '已把「研究项目」调为并排 3 栏'],
      ['open_session', false, '已把「R1」放到第 1 栏'],
      ['open_management_page', false, '已打开设置 · 模型'],
    ]);
    const saved = sessions.getScene(research.projectId);
    // 会话列表新建的在前（R3、R2、R1）：调为 3 栏后是 R3、R2、R1，R1 放进第 1 栏与 R3 互换。
    assert.deepEqual(saved.scene.slots, [r1, r2, r3]);
    assert.equal(saved.scene.parallelCount, 3);
    assert.equal(saved.scene.focusedSessionId, r1);
    assert.equal(sessions.getScene('default').revision, 0);

    // 导航只推给发起窗口；另一个窗口只收到研究项目的现场变更（两次：并排数、栏位），来源是这一轮与发起窗口。
    assert.deepEqual(navigations('window-a'), [
      { kind: 'workspace', workspaceId: research.projectId, sessionId: r3 },
      { kind: 'workspace', workspaceId: research.projectId, sessionId: r1 },
      { kind: 'management', page: 'models', selection: null },
    ]);
    assert.deepEqual(navigations('window-b'), []);
    assert.deepEqual(inbox['window-b']!.flatMap((event) => event.type === 'scene.changed' ? [[event.scene.workspaceId, event.origin]] : []), [
      [research.projectId, { windowId: 'window-a', commandId: 'turn-1' }],
      [research.projectId, { windowId: 'window-a', commandId: 'turn-1' }],
    ]);
    assert.deepEqual(authorizations, []);

    // 发起窗口关闭后：放进栏位只更新保存的现场并如实说明；切换工作区没有执行（工具失败）。
    disconnectA();
    ended.length = 0;
    const [placed, switched] = await prompt('把 R2 放到第一栏，再切到默认工作区',
      { toolCalls: [{ name: 'open_session', arguments: { sessionId: r2, slot: 1 } }] },
      { toolCalls: [{ name: 'switch_workspace', arguments: { workspaceId: 'default' } }] });
    assert.match(placed!, /发起这条消息的界面已经没有打开（窗口已关闭或刷新），没有切换页面；请照实告诉用户。/u);
    assert.match(switched!, /没有切到工作区「默认工作区」：界面没有打开，没有切换。/u);
    assert.deepEqual(sessions.getScene(research.projectId).scene.slots, [r2, r1, r3]);
    assert.deepEqual(ended.map((event) => [event.toolName, event.isError]), [['open_session', false], ['switch_workspace', true]]);
    assert.match(ended[0]!.result!.receipt!.detail, /界面没有打开，只更新了保存的现场$/u);
    assert.equal(navigations('window-b').length, 0);
  } finally {
    runtimes.releaseAll();
    adapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
