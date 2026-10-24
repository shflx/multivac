import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ExecutionDiagnostics } from '../src/application/execution-diagnostics.js';
import { observedModelRuntime } from '../src/runtime/executors/observed-model-runtime.js';
import { patchPiResponses, patchedSource } from '../../../scripts/patch-pi-responses.mjs';
import { createHash } from 'node:crypto';
import { responsesSDK, responsesShared, controlledModel, controlledFetch, terminal, completedItems, textItem, toolItem, reasoningItem } from './fixtures/responses-stream.js';

const options = { apiKey: 'controlled' };

for (const api of ['openai-codex-responses', 'azure-openai-responses']) test(`${api} 共用解析器保留原终止映射和迭代行为`, async () => {
  let continued = false;
  const events = { async *[Symbol.asyncIterator]() {
    // Codex 会把 incomplete 改写为 response.completed，不能套用本次新增的一致性校验。
    yield terminal('response.completed', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    continued = true;
  } };
  const output: any = { content: [], usage: {}, stopReason: 'pending' };
  await responsesShared.processResponsesStream(events, output, { push: () => {} }, { ...controlledModel, api }, {});
  assert.equal(output.stopReason, 'length'); assert.equal(continued, true); assertUsage(output);
});
async function collect(stream: any) {
  const events = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(events.filter(event => ['done', 'error'].includes(event.type)).length, 1);
  return { events, message };
}
function assertUsage(message: any) {
  assert.equal(message.usage.input, 9); assert.equal(message.usage.cacheRead, 2);
  assert.equal(message.usage.output, 5); assert.equal(message.usage.reasoning, 1); assert.equal(message.usage.totalTokens, 16);
}

test('SDK 补丁可重复核对，未知源码拒绝修改', () => {
  assert.equal(patchPiResponses(true), 0);
  assert.equal(patchPiResponses(true), 0);
  const patch = { sha256: createHash('sha256').update('before').digest('hex'), file: 'controlled', edits: [['before', 'after']] };
  assert.equal(patchedSource('before', patch), 'after');
  assert.equal(patchedSource('after', patch), 'after');
  assert.throws(() => patchedSource('unknown', patch));
  assert.throws(() => patchedSource('changed after', patch));
});

for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple']) {
  for (const diagnosticEnabled of [false, true]) test(`${method} 诊断=${diagnosticEnabled}：完成后不等 EOF，完整输出/用量/工具只交付一次`, { timeout: 2000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'responses-terminal-'));
    const diagnostics = new ExecutionDiagnostics(root, sessionId => ({ sessionId, taskId: 'task', runId: 'run', executionId: 'command' }), { enabled: diagnosticEnabled, heartbeatMs: 0 });
    const items = [reasoningItem, textItem, toolItem];
    const final = terminal('response.completed', {}, [{ ...reasoningItem, encrypted_content: 'private-signature' }, textItem, toolItem]);
    // 重复终态及晚到错误与终态在同一块，解析器也必须在首个终态结束。
    const source = controlledFetch([...completedItems(items), final, final, { type: 'error', code: 'late', message: 'late' }]);
    const raw = { stream: responsesSDK.stream, streamSimple: responsesSDK.streamSimple,
      complete: async (...args: any[]) => responsesSDK.stream(...args).result(),
      completeSimple: async (...args: any[]) => responsesSDK.streamSimple(...args).result() } as unknown as ModelRuntime;
    try {
      const runtime = observedModelRuntime(() => raw, 'session', diagnostics) as any;
      const result = runtime[method](controlledModel, { messages: [] }, { ...options, fetch: source.fetch });
      const { message, events } = method.startsWith('complete') ? { message: await result, events: [] } : await collect(result);
      assert.equal(message.stopReason, 'toolUse'); assertUsage(message);
      assert.equal(message.responseId, 'controlled-response');
      assert.equal(message.content[1].text, '完整输出🙂');
      assert.equal(JSON.parse(message.content[0].thinkingSignature).encrypted_content, 'private-signature');
      assert.deepEqual(message.content[2].arguments, { path: 'result.md' });
      assert.equal(message.content.filter((block: any) => block.type === 'toolCall').length, 1);
      if (events.length) assert.equal(events.filter(event => event.type === 'toolcall_end').length, 1);
      assert.equal(source.cancels(), 1); assert.equal(source.body.locked, false);
      assert.equal(source.pulls(), 1, '终态后不再读取晚到网络数据');
      if (diagnosticEnabled) {
        const log = await readFile(diagnostics.path, 'utf8');
        const entries = log.trim().split('\n').map(line => JSON.parse(line));
        const protocol = entries.find(entry => entry.event === 'model.protocol.terminal');
        assert.equal(protocol.protocolTerminalType, 'response.completed'); assert.equal(protocol.runId, 'run');
        assert.equal(entries.filter(entry => entry.event === 'model.protocol.terminal').length, 1);
        assert.equal(entries.filter(entry => entry.event === 'model.http.body_cancelled').length, 1);
        assert.equal(entries.filter(entry => entry.event === 'model.request.ended').length, 1);
        for (const secret of ['完整输出', '受控思考', 'private-signature', 'result.md']) assert.ok(!log.includes(secret));
      }
    } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const [type, extra, reason, error] of [
  ['response.completed', {}, 'stop', undefined],
  ['response.incomplete', { incomplete_details: { reason: 'max_output_tokens' } }, 'length', undefined],
  ['response.incomplete', { incomplete_details: { reason: 'content_filter' } }, 'error', /content_filter/],
  ['response.failed', { error: { code: 'controlled_failure', message: 'provider failed' } }, 'error', /controlled_failure/],
  ['response.cancelled', {}, 'error', /cancelled by provider/],
] as const) test(`${type} ${JSON.stringify(extra)}：终态收敛并保留用量`, { timeout: 2000 }, async () => {
  const source = controlledFetch([...completedItems(), terminal(type, extra), terminal()], { fragmented: true });
  const { message } = await collect(responsesSDK.stream(controlledModel, { messages: [] }, { ...options, fetch: source.fetch }));
  assert.equal(message.stopReason, reason); assertUsage(message);
  assert.equal(message.content[0].text, '完整输出🙂');
  if (error) assert.match(message.errorMessage, error);
  assert.equal(source.cancels(), 1); assert.equal(source.body.locked, false);
});

test('正常 EOF 不改变完成语义；没有终态的 EOF 和错误事件明确失败', { timeout: 2000 }, async () => {
  for (const [events, stopReason, expected] of [
    [[...completedItems(), terminal()], 'stop', undefined],
    [completedItems(), 'error', /before a terminal/],
    [[{ type: 'error', code: 'controlled', message: 'failed' }], 'error', /controlled/],
    [[terminal('response.completed', { status: 'in_progress' })], 'error', /invalid status/],
  ] as const) {
    const source = controlledFetch([...events], { eof: true });
    const { message } = await collect(responsesSDK.stream(controlledModel, { messages: [] }, { ...options, fetch: source.fetch }));
    assert.equal(message.stopReason, stopReason);
    if (expected) assert.match(message.errorMessage, expected);
    assert.equal(source.body.locked, false);
  }
});

test('终态后取消读取失败不能冒充成功，协议终态与资源停止分别记录', { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'responses-cancel-'));
  const diagnostics = new ExecutionDiagnostics(root, sessionId => ({ sessionId }), { heartbeatMs: 0 });
  const source = controlledFetch([...completedItems(), terminal()], { cancelError: new Error('controlled cleanup failed') });
  const raw = { stream: responsesSDK.stream } as unknown as ModelRuntime;
  try {
    const { message } = await collect(observedModelRuntime(() => raw, 'session', diagnostics).stream(controlledModel as never, { messages: [] }, { ...options, fetch: source.fetch }));
    assert.equal(message.stopReason, 'error'); assert.match(message.errorMessage, /cleanup failed/); assertUsage(message);
    const log = await readFile(diagnostics.path, 'utf8');
    assert.ok(log.includes('model.protocol.terminal')); assert.ok(log.includes('model.http.body_cancel_failed'));
    assert.ok(!log.includes('"event":"model.http.body_cancelled"'));
    assert.equal(source.body.locked, false);
  } finally { diagnostics.close(); await rm(root, { recursive: true, force: true }); }
});

test('终止阶段观测回调抛错不改变协议及流释放', { timeout: 2000 }, async () => {
  const source = controlledFetch([...completedItems(), terminal()]);
  const { message } = await collect(responsesSDK.streamSimple(controlledModel, { messages: [] }, { ...options, fetch: source.fetch,
    onProtocolEvent: () => { throw new Error('private observation failure'); } }));
  assert.equal(message.stopReason, 'stop'); assertUsage(message);
  assert.equal(source.cancels(), 1); assert.equal(source.body.locked, false);
});

test('用户取消未终止的响应会结束 SDK，不生成 done 或工具重放', { timeout: 2000 }, async () => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const source = controlledFetch([{ type: 'response.created', response: { id: 'created' } }]);
  const controller = new AbortController();
  const stream = responsesSDK.stream(controlledModel, { messages: [] }, { ...options, fetch: source.fetch, signal: controller.signal, onResponse: () => start() });
  await started; controller.abort();
  const { message, events } = await collect(stream);
  assert.equal(message.stopReason, 'aborted');
  assert.equal(events.filter(event => event.type === 'done').length, 0);
  assert.equal(source.body.locked, false);
});
