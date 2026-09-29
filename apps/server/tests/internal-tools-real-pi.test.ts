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
} from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { InternalToolService, MULTIVAC_INTERNAL_TOOLS } from '../src/application/internal-tools/index.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkspaceSessionService } from '../src/application/workspace-session-service.js';
import type { CoordinatorInternalTools } from '../src/runtime/executors/coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteInternalToolCallRepository,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 真实 Pi 下的内部工具：Pi SDK、customTools 注入、目录边界扩展、SQLite 注册表与项目 / 会话服务全部真实运行，
 * 模型换成本机脚本。内部工具只出现在全局 Multivac 中并可调用（不触发目录授权），工作会话中不可见也调用不到，
 * 参数错误与未声明的工具都不执行；恢复后的全局 Multivac 仍带同一组工具。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 的全局助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

test('真实 Pi：内部工具只注入全局 Multivac 并可调用，工作会话看不到；参数错误与未声明的工具不执行；恢复后仍在', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-internal-tools-'));
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
  const directories = new SessionWorkingDirectories(workPaths, registry, dataDir);
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
  const sessions = new WorkspaceSessionService({
    repository: registry, runtimes, workingDirectories: directories, workspaces,
    sceneRepository: new SqliteWorkspaceSceneRepository(store),
  });
  const projects = new ProjectService({
    projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
  });
  const service = new InternalToolService({
    tools: MULTIVAC_INTERNAL_TOOLS,
    services: { projects, sessions },
    calls: new SqliteInternalToolCallRepository(store),
    currentTurn: () => null,
  });
  // 统计真正进入注册表的调用：工作会话中的同名调用、参数错误都不应走到执行。
  const invoked: string[] = [];
  const internalTools: CoordinatorInternalTools = {
    specs: service.specs,
    validate: (toolName, args) => service.validate(toolName, args),
    invoke: (invocation, signal) => {
      invoked.push(`${invocation.assistantSessionId}:${invocation.toolName}`);
      return service.invoke(invocation, signal);
    },
  };
  const coordinator = () => new AssistantSessionService({
    adapter, bindingRepository: bindings, pageStateRepository: pageStates, runtimeConfig: config,
    resolveWorkingDirectory: () => directories.resolveForRuntime(GLOBAL_ASSISTANT_SESSION_ID),
    kind: 'coordinator', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, internalTools,
  });
  const ended: Array<Extract<CoordinatorAdapterEvent, { type: 'coordinator.tool.ended' }>> = [];
  const prompt = async (sessionId: string, text: string, ...steps: ScriptedStep[]) => {
    model.script(...steps, { text: `${text}：完成。` });
    const run = await adapter.prompt(sessionId, text);
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    return { toolResults: model.takeToolResults(), requests: model.takeRequests() };
  };

  try {
    projects.createProject({ name: '研究项目' });
    const work = (await sessions.create({ sessionId: 'work-a', title: '工作会话' })).session;
    await coordinator().initialize();
    const subscription = adapter.subscribe(GLOBAL_ASSISTANT_SESSION_ID, (event) => {
      if (event.type === 'coordinator.tool.ended') ended.push(event);
    });
    assert.equal(subscription.ok, true);

    // 全局 Multivac：工具已声明给模型，系统提示词带由注册工具生成的说明；调用走真实服务，不产生授权请求。
    const listed = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '有哪些工作区',
      { toolCalls: [{ name: 'list_workspaces', arguments: {} }] });
    assert.deepEqual(listed.requests[0]!.tools.sort(), ['bash', 'edit', 'list_workspaces', 'read', 'write']);
    assert.match(listed.requests[0]!.systemPrompt, /# Multivac 内部工具/u);
    assert.match(listed.requests[0]!.systemPrompt, /- list_workspaces（查询）：列出工作区/u);
    assert.match(listed.requests[0]!.systemPrompt, /# 工作目录与资料范围/u);
    assert.match(listed.toolResults[0]!, /共 2 个工作区/u);
    assert.match(listed.toolResults[0]!, /「研究项目」（id: [^，]+，项目工作区）：主目录（托管）/u);
    assert.match(listed.toolResults[0]!, /「默认工作区」（id: default）：不属于项目，其中的会话各自使用临时目录；1 个未归档会话/u);
    assert.deepEqual(authorizations, []);
    assert.deepEqual(invoked, [`${GLOBAL_ASSISTANT_SESSION_ID}:list_workspaces`]);
    // 结束事件只带公开的结果（白名单），不带工具正文。
    assert.equal(ended.at(-1)!.isError, false);
    assert.equal(ended.at(-1)!.result?.summary, '共 2 个工作区');
    assert.deepEqual(ended.at(-1)!.result?.refs.map((ref) => ref.label), ['研究项目', '默认工作区']);
    assert.equal(JSON.stringify(ended.at(-1)).includes('主目录'), false);

    // 参数校验失败：中文原因回传模型，不执行；未声明的工具被拦截，不执行。
    const rejected = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '参数与未声明的工具',
      { toolCalls: [
        { name: 'list_workspaces', arguments: { workspaceId: 'default' } },
        { name: 'mount_directory', arguments: { path: '/' } },
      ] });
    assert.match(rejected.toolResults[0]!, /列出工作区（list_workspaces）的参数不符合要求：不支持参数 workspaceId。调用没有执行/u);
    assert.match(rejected.toolResults[1]!, /mount_directory not found/u);
    assert.deepEqual(ended.slice(-2).map((event) => [event.toolName, event.isError, event.result]), [
      ['list_workspaces', true, undefined], ['mount_directory', true, undefined],
    ]);
    assert.equal(invoked.length, 1);

    // 工作会话：没有内部工具，提示词里也没有这一段；模型调用同名工具被拦截，注册表没有收到调用。
    await runtimes.acquire(sessions.resolve(work.sessionId)).initialize();
    const inWork = await prompt(work.sessionId, '工作会话里也试试',
      { toolCalls: [{ name: 'list_workspaces', arguments: {} }] });
    assert.deepEqual(inWork.requests[0]!.tools.sort(), ['bash', 'edit', 'read', 'write']);
    assert.doesNotMatch(inWork.requests[0]!.systemPrompt, /Multivac 内部工具|list_workspaces/u);
    assert.match(inWork.toolResults[0]!, /list_workspaces not found/u);
    assert.equal(invoked.length, 1);
    assert.deepEqual(authorizations, []);

    // 恢复：按绑定重新打开全局 Multivac，同一组内部工具照常注入并可调用。
    adapter.disposeSession(GLOBAL_ASSISTANT_SESSION_ID);
    await coordinator().initialize();
    const resumed = await prompt(GLOBAL_ASSISTANT_SESSION_ID, '恢复后再列一次',
      { toolCalls: [{ name: 'list_workspaces', arguments: {} }] });
    assert.ok(resumed.requests[0]!.tools.includes('list_workspaces'));
    assert.match(resumed.toolResults[0]!, /共 2 个工作区/u);
    assert.equal(invoked.length, 2);
  } finally {
    runtimes.releaseAll();
    adapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
