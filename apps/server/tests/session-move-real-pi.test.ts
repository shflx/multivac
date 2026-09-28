import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { ProjectService } from '../src/application/project-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkspaceSessionService } from '../src/application/workspace-session-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteProjectRepository,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteWorkspaceRepository,
  SqliteWorkspaceSceneRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 真实 Pi 下的归入项目：Pi SDK、SessionManager、read / write / bash 工具、SQLite 注册表与工作目录全部真实运行，
 * 模型换成本机脚本。归入后工具在项目目录中执行，会话 id、Pi session 与历史不变，重启后仍在项目目录。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 工作区中的工作会话助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

test('真实 Pi：归入项目后工具在项目目录执行，历史与 Pi session 不变，临时目录文件按规则移入，重启后仍在项目目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-session-move-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  const agentDir = join(dataDir, 'pi-agent');
  const sessionDir = join(dataDir, 'pi-sessions', 'work');
  await configureScriptedModel(agentDir, model.endpoint);
  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });

  /** 一次“服务进程”：新的存储、适配器、运行时集合与会话服务；工作目录每次都从会话记录读取。 */
  const boot = () => {
    const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
    const registry = new SqliteSessionRegistryRepository(store);
    const bindings = new SqliteAssistantBindingRepository(store);
    const workspaces = new SqliteWorkspaceRepository(store);
    const directories = new SessionWorkingDirectories(workPaths, registry, dataDir);
    directories.prepareOnStartup();
    const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir });
    const runtimes = new SessionRuntimeRegistry<SessionRuntime>((record) => {
      const session = new AssistantSessionService({
        adapter,
        bindingRepository: bindings,
        pageStateRepository: new SqliteAssistantPageStateRepository(store),
        selectionRepository: new SqliteSessionSelectionRepository(store),
        runtimeConfig: config,
        resolveWorkingDirectory: () => directories.resolveForRuntime(record.sessionId),
        kind: 'work',
        assistantSessionId: record.sessionId,
        sessionDir,
      });
      return {
        sessionId: record.sessionId,
        initialize: () => session.initialize(),
        isRunning: () => {
          const busy = adapter.isBusy(record.sessionId);
          return busy.ok && busy.value;
        },
        dispose: () => {
          session.close();
          adapter.disposeSession(record.sessionId);
        },
      };
    });
    const service = new WorkspaceSessionService({
      repository: registry, runtimes, workingDirectories: directories, workspaces,
      sceneRepository: new SqliteWorkspaceSceneRepository(store),
    });
    const projects = new ProjectService({
      projects: new SqliteProjectRepository(store), workspaces, workPaths, dataDir, homeDir: home,
    });
    return {
      service, projects, adapter, bindings, runtimes,
      close: () => { runtimes.releaseAll(); adapter.dispose(); store.close(); },
    };
  };
  const prompt = async (context: ReturnType<typeof boot>, sessionId: string, text: string, ...steps: ScriptedStep[]) => {
    await context.runtimes.acquire(context.service.resolve(sessionId)).initialize();
    model.script(...steps, { text: `${text}：完成。` });
    const run = await context.adapter.prompt(sessionId, text);
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    assert.equal(run.ok && run.value.status, 'completed');
    return model.takeToolResults();
  };
  const history = (context: ReturnType<typeof boot>, sessionId: string) => {
    const branch = context.adapter.readActiveBranch(sessionId);
    assert.equal(branch.ok, true);
    return branch.ok ? branch.value.messages.map((message) => `${message.role}:${message.text}`) : [];
  };

  let first: ReturnType<typeof boot> | undefined;
  let second: ReturnType<typeof boot> | undefined;
  try {
    first = boot();
    const { project } = first.projects.createProject({ name: '研究项目' });
    const projectDir = project.directories[0]!.path;
    writeFileSync(join(projectDir, 'README.md'), '项目自己的说明');
    const session = (await first.service.create({ sessionId: 'pi-move', title: '临时探索' })).session;
    const tempDir = session.workingDirectory.path;
    const bindingBefore = first.bindings.get('pi-move');

    // 归入前：工具在临时目录中执行，写下两个文件，其中一个与项目目录已有的文件同名。
    const beforeResults = await prompt(first, 'pi-move', '在临时目录中工作',
      { toolCalls: [
        { name: 'bash', arguments: { command: 'pwd -P' } },
        { name: 'write', arguments: { path: 'findings.md', content: '探索结论' } },
        { name: 'write', arguments: { path: 'README.md', content: '临时目录的说明' } },
      ] });
    assert.match(beforeResults[0]!, new RegExp(escape(realpathSync(tempDir)), 'u'));
    const before = history(first, 'pi-move');

    // 归入项目并移入文件：重名的 README.md 不覆盖，留在原临时目录。
    const moved = await first.service.moveToProject('pi-move', { projectId: project.projectId, moveFiles: true });
    assert.equal(moved.session.sessionId, 'pi-move');
    assert.deepEqual(moved.session.workingDirectory, { kind: 'project-managed', path: projectDir });
    assert.deepEqual(moved.files, { moved: 1, skippedTotal: 1, skipped: ['README.md'] });
    assert.equal(moved.sourceRemoved, false);
    assert.equal(readFileSync(join(projectDir, 'README.md'), 'utf8'), '项目自己的说明');
    assert.equal(readFileSync(join(tempDir, 'README.md'), 'utf8'), '临时目录的说明');

    // 归入后：同一个 Pi session 接续历史，工具以项目目录为 cwd，读到移入的文件，新文件写进项目目录。
    const afterResults = await prompt(first, 'pi-move', '在项目目录中继续',
      { toolCalls: [
        { name: 'bash', arguments: { command: 'pwd -P && cat findings.md' } },
        { name: 'write', arguments: { path: 'next.md', content: '归入后写入' } },
      ] },
      { toolCalls: [{ name: 'read', arguments: { path: 'README.md' } }] });
    assert.match(afterResults[0]!, new RegExp(escape(realpathSync(projectDir)), 'u'));
    assert.match(afterResults[0]!, /探索结论/u);
    assert.match(afterResults[2]!, /项目自己的说明/u);
    assert.equal(readFileSync(join(projectDir, 'next.md'), 'utf8'), '归入后写入');
    assert.equal(existsSync(join(tempDir, 'next.md')), false);
    assert.deepEqual(first.bindings.get('pi-move'), bindingBefore);
    assert.deepEqual(history(first, 'pi-move').slice(0, before.length), before);
    // Pi 会话头仍是新建时的临时目录：工作目录以 Multivac 的记录为准。
    const header = JSON.parse(readFileSync(bindingBefore!.piSessionPath, 'utf8').split('\n')[0]!) as { cwd: string };
    assert.equal(header.cwd, tempDir);
    const afterMove = history(first, 'pi-move');
    first.close();
    first = undefined;

    // 重启：按绑定恢复，仍在项目目录中执行，历史完整。
    second = boot();
    assert.equal(second.service.resolve('pi-move').workspaceId, project.projectId);
    const restartedResults = await prompt(second, 'pi-move', '重启后继续',
      { toolCalls: [{ name: 'bash', arguments: { command: 'pwd -P && cat next.md' } }] });
    assert.match(restartedResults[0]!, new RegExp(escape(realpathSync(projectDir)), 'u'));
    assert.match(restartedResults[0]!, /归入后写入/u);
    assert.deepEqual(history(second, 'pi-move').slice(0, afterMove.length), afterMove);
    assert.deepEqual(second.bindings.get('pi-move'), bindingBefore);
  } finally {
    first?.close();
    second?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
