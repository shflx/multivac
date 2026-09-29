import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type CoordinatorAdapterEvent,
  type CoordinatorRuntimeConfig,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS } from '../src/application/internal-tools/index.js';
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
 * 真实 Pi 下的会话管理工具：Pi SDK、customTools 注入、目录边界扩展、SQLite 注册表、会话服务与账本全部真实运行，
 * 模型换成本机脚本。全局 Multivac 在对话中新建、改名、归档、恢复一个工作会话，效果与界面一致（新会话建立真实的
 * Pi session，归档释放运行时，恢复后按原绑定继续）；同一 toolCallId 的调用再次到达时只返回原结果，不会建出第二个会话。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 的全局助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

test('真实 Pi：对话中新建、改名、归档、恢复工作会话，与界面同一服务；重放同一调用不重复新建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-session-tools-'));
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
  const runtimes = new SessionRuntimeRegistry<SessionRuntime>((record) => {
    const session = new AssistantSessionService({
      adapter, bindingRepository: bindings, pageStateRepository: pageStates, runtimeConfig: config,
      resolveWorkingDirectory: () => directories.resolveForRuntime(record.sessionId),
      kind: 'work', assistantSessionId: record.sessionId, sessionDir: join(dataDir, 'pi-sessions', 'work'),
    });
    return {
      sessionId: record.sessionId,
      initialize: () => session.initialize(),
      isRunning: () => false,
      dispose: () => { session.close(); adapter.disposeSession(record.sessionId); },
    };
  });
  const events = new WorkbenchEvents();
  const published: WorkbenchEvent[] = [];
  events.subscribe((event) => published.push(event));
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store), pageStateRepository: pageStates, events,
  });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
  });
  const research = projects.createProject({ name: '研究项目' }).project;
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: { projects, sessions, transcripts: new SessionTranscriptReader({ registry, bindings, adapter }) },
    calls: new SqliteInternalToolCallRepository(store),
    // 这一轮由窗口 window-a 发出，发送时它的当前工作区是研究项目。
    currentTurn: () => ({
      commandId: 'turn-1', windowId: 'window-a',
      view: { panel: 'home', narrow: false, workspace: { workspaceId: research.projectId, scene: null }, management: null },
    }),
  });
  const ended: Array<Extract<CoordinatorAdapterEvent, { type: 'coordinator.tool.ended' }>> = [];
  const prompt = async (sessionId: string, text: string, ...steps: ScriptedStep[]) => {
    model.script(...steps, { text: `${text}：完成。` });
    const run = await adapter.prompt(sessionId, text);
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    return model.takeToolResults().flat();
  };
  const workSessions = () => sessions.list({ workspaceId: null, includeArchived: true }).sessions;

  try {
    await new AssistantSessionService({
      adapter, bindingRepository: bindings, pageStateRepository: pageStates, runtimeConfig: config,
      resolveWorkingDirectory: () => directories.resolveForRuntime(GLOBAL_ASSISTANT_SESSION_ID),
      kind: 'coordinator', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, internalTools: service,
    }).initialize();
    assert.equal(adapter.subscribe(GLOBAL_ASSISTANT_SESSION_ID, (event) => {
      if (event.type === 'coordinator.tool.ended') ended.push(event);
    }).ok, true);

    // 新建：建在发起窗口的当前工作区（项目），使用项目主目录，建立真实的 Pi session；没有目录授权请求。
    const [createdText] = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '新建一个接口调研的会话',
      { toolCalls: [{ id: 'create-1', name: 'create_session', arguments: { title: '接口调研' } }] });
    assert.match(createdText!, /已在工作区「研究项目」新建会话 \[接口调研\]/u);
    assert.equal(workSessions().length, 1);
    const created = workSessions()[0]!;
    assert.equal(created.workspaceId, research.projectId);
    assert.equal(created.workingDirectory.path, research.directories[0]!.path);
    assert.ok(bindings.get(created.sessionId), '新会话应当建立 Pi session 绑定');
    assert.equal(existsSync(bindings.get(created.sessionId)!.piSessionPath), true);
    assert.deepEqual(ended.at(-1)!.result?.receipt, {
      headline: '已新建会话「接口调研」', detail: '在「研究项目」中',
      actions: [{ kind: 'open-session', sessionId: created.sessionId }],
    });
    assert.equal(JSON.stringify(ended.at(-1)).includes('没有自动打开'), false);

    // 重放：同一 toolCallId 的调用再次到达（例如模型提供方重发），只返回原结果，不建第二个会话、不再发布。
    const eventsBefore = published.length;
    const [replayed] = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '再来一次',
      { toolCalls: [{ id: 'create-1', name: 'create_session', arguments: { title: '接口调研' } }] });
    assert.equal(replayed, createdText);
    assert.equal(workSessions().length, 1);
    assert.equal(published.length, eventsBefore);

    // 新会话照常可以使用：在它里面发一轮，之后读取得到历史。
    await runtimes.acquire(sessions.resolve(created.sessionId)).initialize();
    await prompt(created.sessionId, '先列出接口');

    // 改名、归档（释放运行时，项目目录不清理）、恢复（按原绑定继续）。
    const [renamedText, archivedText] = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '改名并归档', { toolCalls: [
      { name: 'rename_session', arguments: { sessionId: created.sessionId, title: '接口调研（一期）' } },
      { name: 'archive_session', arguments: { sessionId: created.sessionId } },
    ] });
    assert.match(renamedText!, /已把会话「接口调研」改名为 \[接口调研（一期）\]/u);
    assert.match(archivedText!, /已归档会话 \[接口调研（一期）\].*工作目录是项目托管目录，不会被清理。/u);
    assert.notEqual(sessions.get(created.sessionId).archivedAt, null);
    assert.equal(runtimes.get(created.sessionId), undefined);
    assert.deepEqual(ended.at(-1)!.result?.receipt?.actions, [{ kind: 'restore-session', sessionId: created.sessionId }]);

    const [restoredText] = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '恢复它',
      { toolCalls: [{ name: 'restore_session', arguments: { sessionId: created.sessionId } }] });
    assert.match(restoredText!, /已恢复会话 \[接口调研（一期）\].*它回到工作区「研究项目」/u);
    const restored = sessions.get(created.sessionId);
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.title, '接口调研（一期）');
    await runtimes.acquire(sessions.resolve(created.sessionId)).initialize();
    await prompt(created.sessionId, '继续');
    const history = adapter.readActiveBranch(created.sessionId);
    assert.equal(history.ok, true);
    if (history.ok) {
      assert.deepEqual(history.value.messages.filter((message) => message.role === 'user').map((message) => message.text), [
        '先列出接口', '继续',
      ]);
    }

    // 变更事件由服务发布，注明这一轮与发起窗口；重放没有多发。
    assert.deepEqual(published.flatMap((event) => event.type === 'session.changed' ? [[event.change, event.origin]] : []), [
      ['created', { windowId: 'window-a', commandId: 'turn-1' }],
      ['renamed', { windowId: 'window-a', commandId: 'turn-1' }],
      ['archived', { windowId: 'window-a', commandId: 'turn-1' }],
      ['restored', { windowId: 'window-a', commandId: 'turn-1' }],
    ]);
    assert.deepEqual(authorizations, []);
    assert.deepEqual(ended.map((event) => [event.toolName, event.isError]), [
      ['create_session', false], ['create_session', false], ['rename_session', false], ['archive_session', false],
      ['restore_session', false],
    ]);
  } finally {
    runtimes.releaseAll();
    adapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
