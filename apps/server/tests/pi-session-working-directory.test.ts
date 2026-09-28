import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionRuntimeRegistry, type SessionRuntime } from '../src/application/session-runtimes.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { WorkspaceSessionService } from '../src/application/workspace-session-service.js';
import { isPathWithin } from '../src/modules/sessions/working-directory.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteWorkspaceRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 不依赖真实模型凭据的真实 Pi 集成测试：模型换成本机脚本化的 OpenAI Chat Completions 端点，
 * Pi SDK、SessionManager、SettingsManager 与 read / write / bash 工具全部真实运行。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 工作区中的工作会话助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

test('真实 Pi：两个会话各自在记录的工作目录中执行 bash 与读写文件，重启恢复后仍在原目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-working-directory-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  const agentDir = join(dataDir, 'pi-agent');
  const sessionDir = join(dataDir, 'pi-sessions', 'work');
  await configureScriptedModel(agentDir, model.endpoint);

  const workPaths = resolveMultivacWorkPaths(testWorkRoot(root), dataDir);
  const databasePath = join(dataDir, 'multivac.sqlite');

  /** 一次“服务进程”：新的存储、适配器与会话服务；工作目录每次都从会话记录读取。 */
  const boot = () => {
    const store = new SqliteAssistantStore(databasePath);
    const registry = new SqliteSessionRegistryRepository(store);
    const directories = new SessionWorkingDirectories(workPaths, registry, dataDir);
    const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir });
    const service = (sessionId: string) => new AssistantSessionService({
      adapter,
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      selectionRepository: new SqliteSessionSelectionRepository(store),
      runtimeConfig: config,
      resolveWorkingDirectory: () => directories.resolveForRuntime(sessionId),
      kind: 'work',
      assistantSessionId: sessionId,
      sessionDir,
    });
    return {
      registry, directories, adapter, service,
      close: () => { adapter.dispose(); store.close(); },
    };
  };
  const prompt = async (adapter: PiCoordinatorAdapter, sessionId: string, ...steps: ScriptedStep[]) => {
    model.script(...steps, { text: '完成。' });
    const run = await adapter.prompt(sessionId, '执行脚本');
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    assert.equal(run.ok && run.value.status, 'completed');
    return model.takeToolResults();
  };

  let first: ReturnType<typeof boot> | undefined;
  let second: ReturnType<typeof boot> | undefined;
  try {
    first = boot();
    first.directories.prepareOnStartup();
    const createdAt = new Date(2026, 8, 28, 10).toISOString();
    const directories: Record<string, string> = {};
    for (const [sessionId, title] of [['session-a', '会话 A'], ['session-b', '会话 B']] as const) {
      const workingDirectory = first.directories.allocateSessionTemp({ sessionId, title, createdAt });
      first.registry.insertIfAbsent({ sessionId, title, kind: 'work', workspaceId: 'default', createdAt, workingDirectory });
      directories[sessionId] = workingDirectory.path;
    }
    const [dirA, dirB] = [directories['session-a']!, directories['session-b']!];

    const bindings: Record<string, { piSessionPath: string }> = {};
    for (const sessionId of ['session-a', 'session-b']) {
      bindings[sessionId] = await first.service(sessionId).initialize();
    }

    // 两个会话在各自目录中执行命令、写入与读取相对路径的文件。
    for (const [sessionId, directory, label] of [['session-a', dirA, 'A'], ['session-b', dirB, 'B']] as const) {
      const results = await prompt(first.adapter, sessionId,
        { toolCalls: [
          { name: 'bash', arguments: { command: `pwd -P && printf ${label} > from-bash.txt` } },
          { name: 'write', arguments: { path: 'note.txt', content: `written by ${label}` } },
        ] },
        { toolCalls: [{ name: 'read', arguments: { path: 'note.txt' } }] },
      );
      assert.equal(results.length, 3);
      assert.match(results[0]!, new RegExp(realpathSync(directory).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
      assert.match(results[2]!, new RegExp(`written by ${label}`, 'u'));
      assert.equal(readFileSync(join(directory, 'from-bash.txt'), 'utf8'), label);
      assert.equal(readFileSync(join(directory, 'note.txt'), 'utf8'), `written by ${label}`);
      // Pi 会话文件在内部数据目录，新建时会话头记录的 cwd 是会话工作目录。
      const header = JSON.parse(readFileSync(bindings[sessionId]!.piSessionPath, 'utf8').split('\n')[0]!) as { cwd: string };
      assert.equal(header.cwd, directory);
      assert.equal(isPathWithin(sessionDir, bindings[sessionId]!.piSessionPath), true);
    }
    // 文件只出现在各自目录：不串到另一个会话，也不写进服务进程的启动目录。
    assert.deepEqual(readdirSync(dirA).sort(), ['from-bash.txt', 'note.txt']);
    assert.deepEqual(readdirSync(dirB).sort(), ['from-bash.txt', 'note.txt']);
    assert.equal(existsSync(join(process.cwd(), 'from-bash.txt')), false);
    assert.equal(existsSync(join(process.cwd(), 'note.txt')), false);
    first.close();
    first = undefined;

    // 重启：会话 B 的记录换到新目录（归入项目时的做法），模拟会话头中的 cwd 已过期。
    second = boot();
    const dirC = join(workPaths.sessionsDir, 'moved-b');
    second.registry.setWorkingDirectory('session-b', { kind: 'session-temp', path: dirC });
    for (const sessionId of ['session-a', 'session-b']) {
      const restored = await second.service(sessionId).initialize();
      assert.equal(restored.piSessionPath, bindings[sessionId]!.piSessionPath);
    }

    // 会话 A 恢复后仍在原目录，能读到重启前写入的文件。
    const resultsA = await prompt(second.adapter, 'session-a',
      { toolCalls: [{ name: 'bash', arguments: { command: 'pwd -P && cat note.txt' } }] });
    assert.match(resultsA[0]!, new RegExp(realpathSync(dirA).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(resultsA[0]!, /written by A/u);

    // 会话 B 以记录中的新目录执行，不读取 Pi 会话头中的旧 cwd；新目录由运行时启动前补建。
    const resultsB = await prompt(second.adapter, 'session-b',
      { toolCalls: [{ name: 'bash', arguments: { command: 'pwd -P && printf moved > moved.txt' } }] });
    assert.match(resultsB[0]!, new RegExp(realpathSync(dirC).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal(readFileSync(join(dirC, 'moved.txt'), 'utf8'), 'moved');
    assert.equal(existsSync(join(dirB, 'moved.txt')), false);
    const headerB = JSON.parse(readFileSync(bindings['session-b']!.piSessionPath, 'utf8').split('\n')[0]!) as { cwd: string };
    assert.equal(headerB.cwd, dirB);

    for (const directory of [dirA, dirB, dirC]) {
      assert.notEqual(realpathSync(directory), realpathSync(process.cwd()));
      assert.equal(isPathWithin(dataDir, directory), false);
    }
  } finally {
    first?.close();
    second?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('真实 Pi：归档释放运行时后恢复，按原绑定接续历史并在原工作目录继续执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-pi-restore-'));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  const agentDir = join(dataDir, 'pi-agent');
  const sessionDir = join(dataDir, 'pi-sessions', 'work');
  await configureScriptedModel(agentDir, model.endpoint);
  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const adapter = new PiCoordinatorAdapter({ agentDir, sessionDir });
  try {
    const registry = new SqliteSessionRegistryRepository(store);
    const bindingRepository = new SqliteAssistantBindingRepository(store);
    const directories = new SessionWorkingDirectories(resolveMultivacWorkPaths(testWorkRoot(root), dataDir), registry, dataDir);
    const runtimes = new SessionRuntimeRegistry<SessionRuntime & { session: AssistantSessionService }>((record) => {
      const session = new AssistantSessionService({
        adapter,
        bindingRepository,
        pageStateRepository: new SqliteAssistantPageStateRepository(store),
        selectionRepository: new SqliteSessionSelectionRepository(store),
        runtimeConfig: config,
        resolveWorkingDirectory: () => directories.resolveForRuntime(record.sessionId),
        kind: 'work',
        assistantSessionId: record.sessionId,
        sessionDir,
      });
      return {
        sessionId: record.sessionId, session,
        initialize: () => session.initialize(),
        dispose: () => adapter.disposeSession(record.sessionId),
      };
    });
    const service = new WorkspaceSessionService({
      repository: registry, runtimes, workingDirectories: directories, workspaces: new SqliteWorkspaceRepository(store),
    });
    const history = (sessionId: string) => {
      const branch = adapter.readActiveBranch(sessionId);
      assert.equal(branch.ok, true);
      return branch.ok ? branch.value.messages.map((message) => `${message.role}:${message.text}`) : [];
    };

    // 有历史的会话与从未发送过消息的会话各一个。
    const used = (await service.create({ sessionId: 'restore-used', title: '有历史' })).session;
    const blank = (await service.create({ sessionId: 'restore-blank', title: '空会话' })).session;
    model.script({ toolCalls: [{ name: 'write', arguments: { path: 'note.txt', content: '归档前写入' } }] }, { text: '已写入。' });
    const run = await adapter.prompt('restore-used', '写一个文件');
    assert.equal(run.ok && run.value.status, 'completed');
    const before = history('restore-used');
    assert.ok(before.includes('assistant:已写入。'));
    const bindingBefore = bindingRepository.get('restore-used');

    service.archive('restore-used');
    service.archive('restore-blank');
    assert.equal(adapter.readActiveBranch('restore-used').ok, false);

    for (const sessionId of ['restore-used', 'restore-blank']) {
      service.restore(sessionId);
      await runtimes.acquire(service.resolve(sessionId)).initialize();
    }
    // 按原绑定接续：Pi session 与历史不变。
    assert.deepEqual(bindingRepository.get('restore-used'), bindingBefore);
    assert.deepEqual(history('restore-used'), before);
    assert.deepEqual(history('restore-blank'), []);

    // 恢复后继续发送，仍在原工作目录中执行。
    model.script({ toolCalls: [{ name: 'bash', arguments: { command: 'pwd -P && cat note.txt' } }] }, { text: '完成。' });
    const resumed = await adapter.prompt('restore-used', '读回文件');
    assert.equal(resumed.ok && resumed.value.status, 'completed');
    const [output] = model.takeToolResults().slice(-1);
    assert.match(output!, new RegExp(realpathSync(used.workingDirectory.path).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.match(output!, /归档前写入/u);
    assert.deepEqual(history('restore-used').slice(0, before.length), before);

    model.script({ text: '空会话恢复后的回复。' });
    const first = await adapter.prompt('restore-blank', '第一条消息');
    assert.equal(first.ok && first.value.status, 'completed');
    assert.ok(history('restore-blank').includes('assistant:空会话恢复后的回复。'));
    assert.equal(existsSync(blank.workingDirectory.path), true);
  } finally {
    adapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
