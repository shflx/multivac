import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { TaskExecutionService } from '../src/application/task-execution-service.js';
import { TaskService } from '../src/application/task-service.js';
import { ArtifactService } from '../src/application/artifact-service.js';
import { HumanRequestService } from '../src/application/human-request-service.js';
import { AssistantEventStream } from '../src/application/assistant-event-stream.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { observedModelRuntime } from '../src/runtime/executors/observed-model-runtime.js';
import { ExecutionDiagnostics } from '../src/application/execution-diagnostics.js';
import { responsesSDK, controlledModel, controlledFetch, terminal, completedItems, textItem } from './fixtures/responses-stream.js';

const agentRoot = dirname(findPackageJSON('@earendil-works/pi-agent-core', import.meta.resolve('@earendil-works/pi-coding-agent'))!);
const { Agent } = await import(pathToFileURL(join(agentRoot, 'dist/agent.js')).href);
function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

for (const toolFailure of [false, true]) test(`真实 Agent 工具${toolFailure ? '异常' : '成功'}后继续响应，父子候选仅在停止后进入审核，提交回执不冒充交付`, { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'task-responses-'));
  const store = new SqliteAssistantStore(':memory:');
  const stream = new AssistantEventStream(), events = new WorkbenchEvents();
  const diagnostics = new ExecutionDiagnostics(directory, sessionId => ({ sessionId, kind: 'task' }), { heartbeatMs: 0 });
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {}, afterCommit: () => {} });
  const parent = tasks.create({ commandId: 'root', title: '整体', goal: '核验', acceptance: !toolFailure, acceptanceCriteria: '非空文本' }).task;
  const child = tasks.create({ commandId: 'child', title: '子项', goal: '核验', parentTaskId: parent.taskId, acceptance: true }).task;
  await writeFile(join(directory, 'child.md'), '子项成果'); await writeFile(join(directory, 'result.md'), '整体成果');
  let requests!: HumanRequestService, artifacts!: ArtifactService;
  let agent: InstanceType<typeof Agent>, sessionId = '', commandId = '', cursor = 0, sends = 0, calls = 0;
  let commits = 0, reports = 0, submits = 0;
  const toolErrors: unknown[] = [];
  const sources: ReturnType<typeof controlledFetch>[] = [];
  const commitReturned = barrier(), finalEntered = barrier(), allowFinal = barrier(), cleanupEntered = barrier(), allowCleanup = barrier();
  const publish = (type: string, data: unknown) => stream.publish({ type, data, assistantSessionId: sessionId, commandId, cursor: String(++cursor), occurredAt: new Date().toISOString() } as never);
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: stream,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: directory }, baseline: 'controlled-baseline' }),
    createSession: async () => {},
    stopRequiredProcesses: async () => { cleanupEntered.release(); await allowCleanup.promise; return true; },
    settleArtifacts: taskId => artifacts.settle(taskId),
    runtime: () => ({ commands: {
      currentPromptCommandId: () => agent?.state.isStreaming ? commandId : null,
      cancel: async () => { agent.abort(); await agent.waitForIdle(); return {} as never; },
      send: async (command, delivery) => {
        sends++; sessionId = command.assistantSessionId; commandId = command.commandId;
        publish('assistant.command.handed_to_pi', { dispatchMode: 'prompt' });
        const runtime = observedModelRuntime(() => ({ streamSimple: responsesSDK.streamSimple }) as never, sessionId, diagnostics);
        const makeTool = (name: string, execute: (...args: any[]) => Promise<void>) => ({ name, label: name, description: name,
          parameters: { type: 'object', properties: {}, additionalProperties: true },
          execute: async (...args: any[]) => { await execute(...args); return { content: [{ type: 'text', text: '受控工具已返回' }], details: {} }; } });
        agent = new Agent({ initialState: { model: controlledModel, systemPrompt: '受控验证', thinkingLevel: 'off', tools: [
          // 此处只模拟 Git 回执，不访问 Git；验证提交成功与任务交付之间的边界。
          makeTool('commit_task_code', async () => { commits++; commitReturned.release(); if (toolFailure) throw new Error('受控工具失败，结果需核对'); }),
          makeTool('report_task_child', async (id: string) => { reports++; artifacts.reportChild(sessionId, id.replaceAll('|', '-'), child.taskId, '子项已核验', '子项', 'child.md'); }),
          makeTool('submit_task_result', async (id: string) => { submits++; artifacts.registerSession(sessionId, id.replaceAll('|', '-'), '整体', 'result.md'); }),
        ] }, streamFn: async (model: any, context: any, raw: any) => {
          const names = ['commit_task_code', 'report_task_child', 'submit_task_result'];
          const call = calls++;
          if (call === 3) { finalEntered.release(); await allowFinal.promise; }
          assert.ok(call <= 3, '不得重复请求或执行工具');
          const item = call < 3 ? { type: 'function_call', id: `item-${call}`, call_id: `call-${call}`, name: names[call], arguments: '{}', status: 'completed' } : textItem;
          const source = controlledFetch([...completedItems([item]), terminal('response.completed', {}, [item])]);
          sources.push(source);
          return runtime.streamSimple(model, context, { ...raw, apiKey: 'controlled', fetch: source.fetch });
        } });
        agent.subscribe((event: any) => {
          diagnostics.agentEvent(sessionId, event);
          if (event.type === 'turn_start') publish('assistant.turn.started', {});
          if (event.type === 'tool_execution_start') publish('assistant.tool.started', { toolCallId: event.toolCallId, toolName: event.toolName });
          if (event.type === 'tool_execution_end') {
            if (event.isError) toolErrors.push(event.result);
            publish('assistant.tool.ended', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
          }
        });
        delivery?.signal?.addEventListener('abort', () => agent.abort(), { once: true });
        await agent.prompt('执行受控工具并继续回复'); await agent.waitForIdle();
        assert.equal(agent.state.isStreaming, false); assert.equal(agent.state.errorMessage, undefined);
        return { terminalOutcome: 'succeeded', runtimeSessionId: 'controlled-pi', runtimeEntryId: 'controlled-checkpoint' } as never;
      },
    } }),
  });
  requests = new HumanRequestService({ tasks, runs: store.taskRuns, requests: store.humanRequests, execution, events, assistantEvents: stream,
    authorization: { list: () => [], decide: () => { throw new Error('本测试不作授权决定'); } },
    reviewArtifact: (request, input) => artifacts.prepareReview(request, input),
  });
  artifacts = new ArtifactService(tasks, store.taskRuns, store.artifacts, requests, join(directory, 'fixed'));
  const current = () => tasks.get(parent.taskId), run = () => store.taskRuns.get(current().currentRunId!)!;
  try {
    await execution.control(parent.taskId, { commandId: 'start', revision: parent.revision, action: 'start' });
    await commitReturned.promise;
    assert.equal(current().status, 'running'); assert.ok(!current().artifactVersionId);
    await finalEntered.promise;
    assert.equal(commits, 1); assert.equal(reports, 1); assert.equal(submits, 1); assert.equal(toolErrors.length, toolFailure ? 1 : 0);
    assert.ok(run().artifactCandidate); assert.equal(run().stopConfirmed, false); assert.equal(run().executionEndedAt, undefined);
    assert.equal(tasks.get(child.taskId).executionProgress, 'ready');
    assert.equal(artifacts.list(parent.taskId).length, 0); assert.equal(artifacts.list(child.taskId).length, 0);
    assert.equal(requests.list(parent.taskId).length, 0);
    allowFinal.release(); await cleanupEntered.promise;
    assert.ok(run().executionEndedAt); assert.equal(run().stopConfirmed, false);
    assert.equal(artifacts.list(parent.taskId).length, 0, '执行返回仍须等待资源停止');
    allowCleanup.release(); await execution.idle();
    assert.equal(run().stopConfirmed, true); assert.equal(run().status, 'settled');
    assert.equal(run().pendingToolIds.length, 0); assert.equal(run().toolFailures, toolFailure ? 1 : 0);
    assert.equal(current().status, 'review'); assert.equal(tasks.get(child.taskId).status, 'review');
    assert.equal(current().completedAt, null); assert.equal(store.taskRuns.list(child.taskId).length, 0);
    for (const task of [parent, child]) {
      const versions = artifacts.list(task.taskId); assert.equal(versions.length, 1);
      const review = requests.list(task.taskId).find(request => request.kind === 'review')!;
      assert.equal(review.status, 'pending'); assert.equal(review.artifactVersionId, versions[0]!.versionId); assert.equal(review.runId, run().runId);
    }
    assert.equal(sends, 1); assert.equal(calls, 4);
    for (const source of sources) { assert.equal(source.cancels(), 1); assert.equal(source.body.locked, false); }
    t.diagnostic(JSON.stringify({ sends, modelRequests: calls, commits, reports, submits, toolFailures: run().toolFailures, cancelledStreams: sources.length,
      run: run().status, stopConfirmed: run().stopConfirmed, parent: current().status, child: tasks.get(child.taskId).status,
      parentArtifacts: artifacts.list(parent.taskId).length, childArtifacts: artifacts.list(child.taskId).length }));
  } finally {
    allowFinal.release(); allowCleanup.release(); agent?.abort();
    await execution.idle(); requests.dispose(); artifacts.dispose(); execution.dispose(); diagnostics.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('协议已终止但流取消挂起时，阶段兜底保留停止门禁，迟到收敛不重放执行', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const directory = await mkdtemp(join(tmpdir(), 'responses-stop-'));
  const store = new SqliteAssistantStore(':memory:');
  const tasks = new TaskService({ facts: store.taskFacts, requireProject: () => {}, afterCommit: () => {} });
  const stream = new AssistantEventStream();
  const diagnostics = new ExecutionDiagnostics(directory, sessionId => ({ sessionId }), { heartbeatMs: 0 });
  const cancelEntered = barrier(), allowCancel = barrier();
  const source = controlledFetch([...completedItems(), terminal()], { onCancel: cancelEntered.release, cancelWait: allowCancel.promise });
  let sends = 0, cancels = 0, sdkFinished = false;
  const execution = new TaskExecutionService({ tasks, runs: store.taskRuns, events: stream, requestIdleTimeoutMs: 100, stopTimeoutMs: 20,
    prepare: async () => ({ directory: { kind: 'task-isolated', path: directory }, baseline: null }), createSession: async () => {},
    settleArtifacts: async () => {},
    runtime: () => ({ commands: {
      currentPromptCommandId: () => 'controlled-command',
      cancel: async () => { cancels++; return {} as never; },
      send: async (command, delivery) => {
        sends++;
        stream.publish({ type: 'assistant.command.handed_to_pi', data: { dispatchMode: 'prompt' }, cursor: '1',
          assistantSessionId: command.assistantSessionId, commandId: command.commandId, occurredAt: new Date().toISOString() } as never);
        const runtime = observedModelRuntime(() => ({ streamSimple: responsesSDK.streamSimple }) as never, command.assistantSessionId, diagnostics);
        const message = await runtime.streamSimple(controlledModel as never, { messages: [] }, { apiKey: 'controlled', fetch: source.fetch, signal: delivery?.signal }).result();
        sdkFinished = true;
        return { terminalOutcome: message.stopReason === 'aborted' ? 'cancelled' : 'succeeded', runtimeEntryId: 'checkpoint' } as never;
      },
    } }),
  });
  const task = tasks.create({ commandId: 'create', title: '取消流核对', goal: '核对原执行' }).task;
  const run = () => store.taskRuns.get(tasks.get(task.taskId).currentRunId!)!;
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  try {
    await execution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await cancelEntered.promise;
    assert.equal(sdkFinished, false);
    const log = await readFile(diagnostics.path, 'utf8');
    assert.ok(log.includes('model.protocol.terminal')); assert.ok(log.includes('model.http.body_cancel_requested'));
    assert.ok(!log.includes('"event":"model.http.body_cancelled"')); assert.ok(!log.includes('model.request.ended'));
    t.mock.timers.tick(100); await flush(); t.mock.timers.tick(20); await flush();
    assert.equal(tasks.get(task.taskId).status, 'recovery'); assert.equal(run().stopConfirmed, false);
    assert.equal(run().requestTimeout?.phase, 'first-response');
    await assert.rejects(execution.control(task.taskId, { commandId: 'unsafe', revision: tasks.get(task.taskId).revision, action: 'resume' }), /尚未确认停止/);
    assert.equal(sends, 1); assert.equal(cancels, 1);
    allowCancel.release(); await execution.idle();
    assert.equal(sdkFinished, true); assert.equal(run().stopConfirmed, true); assert.equal(tasks.get(task.taskId).status, 'paused');
    assert.equal(sends, 1); assert.equal(source.cancels(), 1); assert.equal(source.body.locked, false);
    t.diagnostic(JSON.stringify({ protocolTerminalReceived: true, cancelledInitially: false, recoveryBeforeStop: true,
      sdkFinished, stopConfirmed: run().stopConfirmed, status: tasks.get(task.taskId).status, sends, cancels }));
  } finally {
    allowCancel.release(); await execution.idle(); execution.dispose(); diagnostics.close(); store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
