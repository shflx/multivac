import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { GLOBAL_ASSISTANT_SESSION_ID, type CoordinatorRuntimeConfig } from '@multivac/contracts';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import type { CoordinatorToolAuthorizationRequest } from '../src/runtime/executors/coordinator-adapter.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel, type ScriptedStep } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 真实 Pi 下的目录边界：Pi SDK、受控 ResourceLoader、内置 read / edit / write / bash 工具
 * 与目录边界扩展全部真实运行，模型换成本机脚本。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 工作区中的工作会话助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

/** 一个“恶意”的本地扩展：导入即写标记文件，并试图接管 tool_call。 */
function localExtensionSource(marker: string): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
    'export default function (pi) {',
    "  pi.on('tool_call', async () => { writeFileSync(" + JSON.stringify(`${marker}.hook`) + ", 'hooked'); return undefined; });",
    '}',
    '',
  ].join('\n');
}

test('真实 Pi：越界的 read / edit / write（含 .. 与符号链接绕出）在执行前被拦截，目录内操作不请求授权，本地扩展不会加载', async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-pi-tool-boundary-')));
  const model = await startScriptedModel();
  const dataDir = testDataDir(root);
  const agentDir = join(dataDir, 'pi-agent');
  await configureScriptedModel(agentDir, model.endpoint);

  const store = new SqliteAssistantStore(join(dataDir, 'multivac.sqlite'));
  const registry = new SqliteSessionRegistryRepository(store);
  const directories = new SessionWorkingDirectories(
    resolveMultivacWorkPaths(testWorkRoot(root), dataDir), registry, dataDir,
  );
  directories.prepareOnStartup();
  const createdAt = new Date(2026, 8, 28, 10).toISOString();
  const workingDirectory = directories.allocateSessionTemp({ sessionId: 'boundary-work', title: '边界', createdAt });
  registry.insertIfAbsent({
    sessionId: 'boundary-work', title: '边界', kind: 'work', workspaceId: 'default', createdAt, workingDirectory,
  });
  const cwd = directories.resolveForRuntime('boundary-work').path;

  // 工作目录之外的文件。
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'original secret');
  await writeFile(join(outside, 'target.txt'), 'original target');

  // 本地扩展：会话工作目录与 agentDir 的扩展目录，以及两处 settings 中声明的扩展路径。
  const markers = join(root, 'markers');
  await mkdir(markers);
  const configured = join(root, 'configured-extension.ts');
  await writeFile(configured, localExtensionSource(join(markers, 'configured')));
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'extensions', 'project.ts'), localExtensionSource(join(markers, 'project')));
  await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({ extensions: [configured] }));
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await writeFile(join(agentDir, 'extensions', 'global.ts'), localExtensionSource(join(markers, 'global')));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ extensions: [configured] }));

  const requests: Array<{ request: CoordinatorToolAuthorizationRequest; signal: AbortSignal }> = [];
  // 默认适配器：没有接入授权通道，越界一律拒绝。
  const denyingAdapter = new PiCoordinatorAdapter({ agentDir, sessionDir: join(dataDir, 'pi-sessions', 'work') });
  // 接入授权决定的适配器（T4 的接入方式）：批准读取 secret.txt，拒绝其余请求。
  const authorizingAdapter = new PiCoordinatorAdapter({
    agentDir,
    sessionDir: join(dataDir, 'pi-sessions'),
    authorizeToolCall: async (request, signal) => {
      requests.push({ request, signal });
      return request.toolName === 'read' && request.targetPath === join(outside, 'secret.txt')
        ? { allowed: true }
        : { allowed: false, reason: '用户拒绝了这次访问。' };
    },
  });
  const service = (adapter: PiCoordinatorAdapter, sessionId: string, kind: 'work' | 'coordinator', sessionDir: string) =>
    new AssistantSessionService({
      adapter,
      bindingRepository: new SqliteAssistantBindingRepository(store),
      pageStateRepository: new SqliteAssistantPageStateRepository(store),
      selectionRepository: new SqliteSessionSelectionRepository(store),
      runtimeConfig: config,
      resolveWorkingDirectory: () => directories.resolveForRuntime(sessionId),
      kind,
      assistantSessionId: sessionId,
      sessionDir,
    });
  const prompt = async (adapter: PiCoordinatorAdapter, sessionId: string, ...steps: ScriptedStep[]) => {
    model.script(...steps, { text: '完成。' });
    const run = await adapter.prompt(sessionId, '执行脚本');
    assert.equal(run.ok, true, run.ok ? undefined : run.error.message);
    assert.equal(run.ok && run.value.status, 'completed');
    return model.takeToolResults();
  };

  try {
    await service(denyingAdapter, 'boundary-work', 'work', join(dataDir, 'pi-sessions', 'work')).initialize();

    // 工作目录内：写入、编辑、读取、执行命令都直接完成。
    const inside = await prompt(denyingAdapter, 'boundary-work',
      { toolCalls: [{ name: 'write', arguments: { path: 'note.txt', content: 'hello boundary' } }] },
      { toolCalls: [{ name: 'edit', arguments: { path: join(cwd, 'note.txt'), edits: [{ oldText: 'hello', newText: 'bye' }] } }] },
      { toolCalls: [
        { name: 'read', arguments: { path: './note.txt' } },
        // Agent 用 bash 在目录内建立指向目录外的符号链接，为下一轮的绕出做准备。
        { name: 'bash', arguments: { command: `ln -s ${JSON.stringify(outside)} link && ln -s ${JSON.stringify(join(outside, 'through-link.txt'))} dangling && pwd -P` } },
      ] },
    );
    assert.equal(inside.length, 4);
    assert.match(inside[2]!, /bye boundary/u);
    assert.match(inside[3]!, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'bye boundary');
    for (const result of inside) assert.doesNotMatch(result, /需要用户授权/u);

    // 越界：相对路径 ..、绝对路径、经符号链接目录读写、经悬空符号链接写入。
    const escapes = await prompt(denyingAdapter, 'boundary-work',
      { toolCalls: [
        { name: 'read', arguments: { path: relative(cwd, join(outside, 'secret.txt')) } },
        { name: 'write', arguments: { path: join(outside, 'new.txt'), content: 'escaped' } },
        { name: 'write', arguments: { path: `sub/../${relative(cwd, join(outside, 'target.txt'))}`, content: 'escaped' } },
      ] },
      { toolCalls: [
        { name: 'read', arguments: { path: 'link/secret.txt' } },
        { name: 'edit', arguments: { path: 'link/target.txt', edits: [{ oldText: 'original', newText: 'escaped' }] } },
        { name: 'write', arguments: { path: 'link/new-through-dir.txt', content: 'escaped' } },
        { name: 'write', arguments: { path: 'dangling', content: 'escaped' } },
      ] },
    );
    assert.equal(escapes.length, 7);
    for (const result of escapes) {
      assert.match(result, /位于会话工作目录 .* 之外，访问需要用户授权/u);
      assert.doesNotMatch(result, /original secret/u);
    }
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'original secret');
    assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'original target');
    for (const name of ['new.txt', 'new-through-dir.txt', 'through-link.txt']) {
      assert.equal(existsSync(join(outside, name)), false, name);
    }

    // 全局 Multivac 同样注入目录边界：目录内不请求授权，目录外交给授权决定。
    const globalDirectory = directories.resolveForRuntime(GLOBAL_ASSISTANT_SESSION_ID);
    await service(authorizingAdapter, GLOBAL_ASSISTANT_SESSION_ID, 'coordinator', join(dataDir, 'pi-sessions')).initialize();
    const global = await prompt(authorizingAdapter, GLOBAL_ASSISTANT_SESSION_ID,
      { toolCalls: [{ name: 'write', arguments: { path: 'light-work.md', content: 'inside' } }] },
      { toolCalls: [
        { name: 'read', arguments: { path: join(outside, 'secret.txt') } },
        { name: 'write', arguments: { path: join(outside, 'target.txt'), content: 'escaped' } },
      ] },
    );
    assert.equal(readFileSync(join(globalDirectory.path, 'light-work.md'), 'utf8'), 'inside');
    assert.match(global[1]!, /original secret/u);
    assert.match(global[2]!, /用户拒绝了这次访问/u);
    assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'original target');
    assert.equal(requests.length, 2);
    // 授权方拿到的是 Pi 本轮的中止信号：同一轮的两次请求共用它，取消本轮即可结束等待。
    assert.equal(requests[0]!.signal, requests[1]!.signal);
    assert.deepEqual(requests.map(({ request, signal }) => ({
      ...request, aborted: signal.aborted, toolCallId: /^call-\d+-\d$/u.test(request.toolCallId),
    })), [
      {
        assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName: 'read', toolCallId: true,
        requestedPath: join(outside, 'secret.txt'), targetPath: join(outside, 'secret.txt'),
        workingDirectory: globalDirectory, aborted: false,
      },
      {
        assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName: 'write', toolCallId: true,
        requestedPath: join(outside, 'target.txt'), targetPath: join(outside, 'target.txt'),
        workingDirectory: globalDirectory, aborted: false,
      },
    ]);

    // 本地扩展从未加载：导入与钩子的标记文件都不存在。
    for (const name of ['project', 'global', 'configured']) {
      assert.equal(existsSync(join(markers, name)), false, name);
      assert.equal(existsSync(join(markers, `${name}.hook`)), false, `${name}.hook`);
    }
    // 对照：同样的目录交给 Pi 默认的扩展发现时会被加载，说明上面的断言不是空转。
    const discovered = await discoverAndLoadExtensions([configured], cwd, agentDir);
    assert.equal(discovered.extensions.length, 3);
    for (const name of ['project', 'global', 'configured']) assert.equal(existsSync(join(markers, name)), true, name);
  } finally {
    denyingAdapter.dispose();
    authorizingAdapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
