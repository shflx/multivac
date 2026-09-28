import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CoordinatorRuntimeConfig, ToolAuthorizationRequest } from '@multivac/contracts';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { AssistantSessionService } from '../src/application/assistant-session-service.js';
import { SessionWorkingDirectories } from '../src/application/session-working-directories.js';
import {
  ToolAuthorizationService,
  ToolAuthorizationServiceError,
} from '../src/application/tool-authorization-service.js';
import { PiCoordinatorAdapter } from '../src/runtime/executors/pi-coordinator-adapter.js';
import {
  SqliteAssistantBindingRepository,
  SqliteAssistantPageStateRepository,
  SqliteAssistantStore,
  SqliteSessionRegistryRepository,
  SqliteSessionSelectionRepository,
  SqliteToolAuthorizationRepository,
} from '../src/storage/sqlite-assistant-store.js';
import { resolveMultivacWorkPaths } from '../src/storage/work-paths.js';
import { configureScriptedModel, startScriptedModel } from './fixtures/scripted-model.js';
import { testDataDir, testWorkRoot } from './fixtures/test-environment.js';

/**
 * 真实 Pi 下的授权等待：Pi SDK、目录边界扩展、内置 write 工具、授权服务与 SQLite 全部真实运行，
 * 模型换成本机脚本。验证批准后真实执行、拒绝后未执行，以及等待中取消与超时都会结束本轮。
 */

const config: CoordinatorRuntimeConfig = {
  systemPrompt: '你是 Multivac 工作区中的工作会话助手。',
  authorizedContext: [],
  model: { source: 'base', provider: 'local-scripted', modelId: 'scripted', thinkingLevel: 'off' },
  retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
  compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 2_000 },
};

const SESSION_ID = 'authorization-real-pi';

/** 一个真实 Pi 工作会话：脚本模型、目录边界扩展、授权服务与 SQLite 全部真实运行。 */
async function withRealPi(run: (context: {
  outside: string;
  model: Awaited<ReturnType<typeof startScriptedModel>>;
  eventStream: AssistantEventStream;
  authorization: ToolAuthorizationService;
  adapter: PiCoordinatorAdapter;
  session: AssistantSessionService;
}) => Promise<void>): Promise<void> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'multivac-pi-authorization-')));
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
  const workingDirectory = directories.allocateSessionTemp({ sessionId: SESSION_ID, title: '授权', createdAt });
  registry.insertIfAbsent({
    sessionId: SESSION_ID, title: '授权', kind: 'work', workspaceId: 'default', createdAt, workingDirectory,
  });
  const outside = join(root, 'outside');
  await mkdir(outside);

  const eventStream = new AssistantEventStream();
  const authorization = new ToolAuthorizationService({
    repository: new SqliteToolAuthorizationRepository(store),
    eventStream,
    currentCommandId: () => null,
    projectOf: () => null,
    rememberBoundary: { homeDir: join(root, 'home'), workRoot: testWorkRoot(root), dataDir },
  });
  const adapter = new PiCoordinatorAdapter({
    agentDir,
    sessionDir: join(dataDir, 'pi-sessions'),
    authorizeToolCall: authorization.authorize,
  });
  const session = new AssistantSessionService({
    adapter,
    bindingRepository: new SqliteAssistantBindingRepository(store),
    pageStateRepository: new SqliteAssistantPageStateRepository(store),
    selectionRepository: new SqliteSessionSelectionRepository(store),
    runtimeConfig: config,
    resolveWorkingDirectory: () => directories.resolveForRuntime(SESSION_ID),
    kind: 'work',
    assistantSessionId: SESSION_ID,
    sessionDir: join(dataDir, 'pi-sessions'),
  });

  try {
    await run({ outside, model, eventStream, authorization, adapter, session });
  } finally {
    authorization.dispose();
    adapter.dispose();
    store.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** 等待下一条授权请求（待授权事件）。 */
function nextRequest(eventStream: AssistantEventStream): Promise<ToolAuthorizationRequest> {
  return new Promise((resolve) => {
    const unsubscribe = eventStream.subscribe((event) => {
      if (event.type !== 'assistant.authorization.requested') return;
      unsubscribe();
      resolve(event.data.request);
    });
  });
}

async function runStatus(run: ReturnType<PiCoordinatorAdapter['prompt']>) {
  const result = await run;
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.ok ? result.value.status : undefined;
}

test('真实 Pi：越界写入等待授权，批准后执行、拒绝后未执行；等待中取消与超时都结束本轮且不执行', async () => {
  await withRealPi(async ({ outside, model, eventStream, authorization, adapter, session }) => {
    /**
     * 让 Agent 写入目录外的文件，等到授权请求生成；返回仍在进行的本轮。
     * continues 表示本轮在工具之后还会请求模型（批准、拒绝），取消与超时的本轮不再请求。
     */
    const writeOutside = async (name: string, content: string, continues = true) => {
      const requested = nextRequest(eventStream);
      model.script({ toolCalls: [{ name: 'write', arguments: { path: join(outside, name), content } }] });
      if (continues) model.script({ text: '完成。' });
      const run = adapter.prompt(SESSION_ID, `写入 ${name}`);
      const request = await requested;
      // 等待期间本轮保持运行，工具尚未执行。
      assert.equal(adapter.isStreaming(SESSION_ID).ok && adapter.isStreaming(SESSION_ID).value, true);
      assert.equal(existsSync(join(outside, name)), false);
      return { run, request };
    };

    const binding = await session.initialize();

    // 批准：Pi 的 write 工具真实写入目录外的文件，Agent 收到成功结果后完成本轮。
    const approve = await writeOutside('approved.txt', 'approved by user');
    assert.equal(approve.request.targetPath, join(outside, 'approved.txt'));
    assert.match(approve.request.toolCallId, /^call-\d+-0$/u);
    authorization.decide(SESSION_ID, approve.request.requestId, 'once');
    assert.equal(await runStatus(approve.run), 'completed');
    assert.equal(readFileSync(join(outside, 'approved.txt'), 'utf8'), 'approved by user');
    const approvedResults = model.takeToolResults();
    assert.equal(approvedResults.length, 1);
    assert.doesNotMatch(approvedResults[0]!, /拒绝|授权/u);

    // 拒绝：文件没有写入，拒绝原因作为工具结果回传，Agent 继续回应，本轮正常完成。
    const deny = await writeOutside('denied.txt', 'should not exist');
    authorization.decide(SESSION_ID, deny.request.requestId, 'deny');
    assert.equal(await runStatus(deny.run), 'completed');
    assert.equal(existsSync(join(outside, 'denied.txt')), false);
    const deniedResults = model.takeToolResults();
    assert.equal(deniedResults.length, 1);
    assert.match(deniedResults[0]!, /用户拒绝了这次授权：没有写入 .*denied\.txt/u);

    // 等待中取消：abort 立即结束等待，本轮取消，请求记为已取消，之后的批准不执行任何操作。
    const cancel = await writeOutside('cancelled.txt', 'should not exist', false);
    const aborted = await adapter.abort(SESSION_ID);
    assert.equal(aborted.ok, true);
    assert.equal(await runStatus(cancel.run), 'cancelled');
    assert.equal(authorization.list(SESSION_ID).find((item) => item.requestId === cancel.request.requestId)?.status, 'cancelled');
    assert.throws(() => authorization.decide(SESSION_ID, cancel.request.requestId, 'once'), ToolAuthorizationServiceError);
    assert.equal(existsSync(join(outside, 'cancelled.txt')), false);
    assert.deepEqual(model.takeToolResults(), [], '取消后本轮没有再发起模型请求');

    // 超时：请求过期，该调用以过期原因结束（写入 transcript），随后本轮结束，不再请求模型。
    authorization.setTimeoutForTest(100);
    const expire = await writeOutside('expired.txt', 'should not exist', false);
    assert.equal(await runStatus(expire.run), 'cancelled');
    assert.equal(authorization.list(SESSION_ID).find((item) => item.requestId === expire.request.requestId)?.status, 'expired');
    assert.equal(existsSync(join(outside, 'expired.txt')), false);
    assert.deepEqual(model.takeToolResults(), [], '过期后本轮没有再发起模型请求');
    assert.match(readFileSync(binding.piSessionPath, 'utf8'), /等待用户授权超时，请求已过期：没有写入 .*expired\.txt/u);

    // 结束的本轮不影响之后的发送。
    authorization.setTimeoutForTest(null);
    model.script({ text: '继续工作。' });
    assert.equal(await runStatus(adapter.prompt(SESSION_ID, '继续')), 'completed');
  });
});

test('真实 Pi：选择“本会话内允许”后，同一目录中的第二次越界写入不再产生授权请求；撤销后再次确认', async () => {
  await withRealPi(async ({ outside, model, eventStream, authorization, adapter, session }) => {
    await session.initialize();
    const reports = join(outside, 'reports');
    await mkdir(reports);
    const requested: ToolAuthorizationRequest[] = [];
    eventStream.subscribe((event) => {
      if (event.type === 'assistant.authorization.requested') requested.push(event.data.request);
    });

    // 第一次：出现待授权请求，用户选择“本会话内允许”。
    const first = nextRequest(eventStream);
    model.script({ toolCalls: [{ name: 'write', arguments: { path: join(reports, 'a.md'), content: 'first' } }] });
    model.script({ text: '已写入。' });
    const firstRun = adapter.prompt(SESSION_ID, '写入 a.md');
    const request = await first;
    assert.deepEqual(request.remember, { directory: reports, projectId: null });
    authorization.decide(SESSION_ID, request.requestId, 'session');
    assert.equal(await runStatus(firstRun), 'completed');
    model.takeToolResults();

    // 第二次：写入同一目录下的子目录，Pi 真实写入，没有产生任何待授权请求。
    const target = join(reports, 'sub', 'b.md');
    await mkdir(join(reports, 'sub'));
    model.script({ toolCalls: [{ name: 'write', arguments: { path: target, content: 'second' } }] });
    model.script({ text: '也写好了。' });
    assert.equal(await runStatus(adapter.prompt(SESSION_ID, '写入 b.md')), 'completed');
    assert.equal(readFileSync(target, 'utf8'), 'second');
    assert.equal(requested.length, 1, '记住后第二次越界调用不触发请求');
    const auto = authorization.list(SESSION_ID).at(-1)!;
    assert.equal(auto.targetPath, target);
    assert.equal(auto.status, 'approved');
    assert.equal(auto.approval?.source, 'grant');
    assert.doesNotMatch(model.takeToolResults()[0]!, /拒绝|授权/u);

    // 撤销后同类调用重新确认；拒绝后文件没有写入。
    authorization.revokeGrant(auto.approval!.grantId!);
    const third = nextRequest(eventStream);
    model.script({ toolCalls: [{ name: 'write', arguments: { path: join(reports, 'c.md'), content: 'third' } }] });
    model.script({ text: '好的。' });
    const thirdRun = adapter.prompt(SESSION_ID, '写入 c.md');
    authorization.decide(SESSION_ID, (await third).requestId, 'deny');
    assert.equal(await runStatus(thirdRun), 'completed');
    assert.equal(existsSync(join(reports, 'c.md')), false);
  });
});
