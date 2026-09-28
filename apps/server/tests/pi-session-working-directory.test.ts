import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import { isPathWithin } from '../src/modules/sessions/working-directory.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 不依赖真实模型凭据的真实 Pi 集成测试：模型换成本机脚本化的 OpenAI Chat Completions 端点，
 * Pi SDK、SessionManager、SettingsManager 与 read / write / bash 工具全部真实运行。
 */

type ScriptedStep =
  | { toolCalls: Array<{ name: 'bash' | 'read' | 'write'; arguments: Record<string, string> }> }
  | { text: string };

/** 按顺序回放脚本的本机模型端点；记录每次请求中 Pi 回传的工具结果。 */
async function startScriptedModel() {
  const steps: ScriptedStep[] = [];
  const toolResults: string[][] = [];
  let calls = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      // 只取本轮新增的工具结果：最后一条非 tool 消息之后的 tool 消息。
      const trailing: string[] = [];
      for (let index = body.messages.length - 1; index >= 0 && body.messages[index]!.role === 'tool'; index -= 1) {
        const content = body.messages[index]!.content;
        trailing.unshift(typeof content === 'string' ? content : JSON.stringify(content));
      }
      toolResults.push(trailing);
      const step = steps.shift();
      const id = `chatcmpl-local-${calls += 1}`;
      const chunk = (delta: unknown, finishReason: string | null = null) =>
        ({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [{ index: 0, delta, finish_reason: finishReason }] });
      const frames = !step
        ? [chunk({ role: 'assistant', content: '脚本已用尽。' }), chunk({}, 'stop')]
        : 'text' in step
          ? [chunk({ role: 'assistant', content: step.text }), chunk({}, 'stop')]
          : [chunk({
              role: 'assistant',
              tool_calls: step.toolCalls.map((call, index) => ({
                index, id: `call-${calls}-${index}`, type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }), chunk({}, 'tool_calls')];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'scripted', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    script: (...next: ScriptedStep[]) => { steps.push(...next); },
    /** 最近一轮 prompt 中各次请求回传的工具结果，按请求顺序展开。 */
    takeToolResults: () => toolResults.splice(0).flat(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: { 'local-scripted': { baseUrl: model.endpoint, api: 'openai-completions', models: [{ id: 'scripted' }] } },
  }));
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'local-scripted': { type: 'api_key', key: 'local-test-only' },
  }), { mode: 0o600 });

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
