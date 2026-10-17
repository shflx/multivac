import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Task } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { renderTaskExecutionPrompt } from '../src/application/task-execution-prompt.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

type App = ReturnType<typeof createMultivacApplication>;
const taskInput = { commandId: 'create', title: '核对日志', goal: '修复日志并保留用户输入。', scope: '仅修改日志模块。', acceptanceCriteria: '提交可核对的差异与验证证据。' };
const prompts = (adapter: FakeCoordinatorAdapter) => adapter.calls.filter(call => call.method === 'prompt');

async function fixture(run: (app: App, adapter: FakeCoordinatorAdapter) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'multivac-inbox-prompt-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  try { await app.ready; await run(app, adapter); }
  finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); await app.close(); await rm(root, { recursive: true, force: true }); }
}

async function start(app: App, withChild = false) {
  const task = app.tasks.create(taskInput).task;
  if (withChild) app.tasks.create({ commandId: 'child', title: '检查日志来源', goal: '核对日志模块来源', parentTaskId: task.taskId });
  await app.taskExecution.control(task.taskId, { commandId: 'start', revision: app.tasks.get(task.taskId).revision, action: 'start' });
  await app.taskExecution.idle();
  return app.tasks.get(task.taskId);
}
function assertIncremental(text: string, task: Task) {
  assert.match(text, /get_task\(taskId=/);
  assert.match(text, /原人工请求、运行停止事实/);
  assert.match(text, /不重放副作用/);
  assert.match(text, /不扩大目录、权限或验收边界/);
  for (const original of [task.goal, task.scope, task.acceptanceCriteria]) assert.ok(!text.includes(original));
  assert.doesNotMatch(text, /commit_task_code|submit_task_result|report_task_child|^任务：|^验收要求：/m);
}

for (const withChild of [false, true]) test(`Inbox 回应进入原${withChild ? '父任务' : '单任务'}会话时只追加回应，重复决定不重发`, { skip: process.platform !== 'darwin' }, async t => {
  await fixture(async (app, adapter) => {
    const task = await start(app, withChild);
    const firstRun = app.tasks.detail(task.taskId).runs![0]!;
    const request = app.humanRequests.create(task.taskId, 'clarification', '日志保留几天？', 'ask');
    const answer = '保留 7 天。\n  保留原始格式 🧪';
    const decision = { commandId: 'answer', revision: request.revision, decision: 'answer' as const, answer };
    await app.inbox.decide(request.requestId, decision);
    await app.taskExecution.idle();
    const sent = prompts(adapter);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.assistantSessionId, firstRun.sessionId);
    assertIncremental(sent[1]!.text, task);
    assert.ok(sent[1]!.text.includes(answer));
    assert.ok(sent[1]!.text.includes(request.question));
    assert.ok(sent[1]!.text.includes(request.requestId));
    assert.equal(sent[1]!.text.includes('get_task_execution_tree'), withChild);
    const full = renderTaskExecutionPrompt(app.tasks.get(task.taskId), { childCount: withChild ? 1 : 0, resumed: true });
    const beforeCharacters = Array.from(full).length, afterCharacters = Array.from(sent[1]!.text).length;
    assert.ok(afterCharacters < beforeCharacters / 2, `${afterCharacters}/${beforeCharacters}`);
    t.diagnostic(`Inbox 续发正文：${beforeCharacters} → ${afterCharacters} 字符，减少 ${(100 * (1 - afterCharacters / beforeCharacters)).toFixed(1)}%。`);
    await app.inbox.decide(request.requestId, decision); await app.taskExecution.idle();
    assert.equal(prompts(adapter).length, 2);

    const next = app.humanRequests.create(task.taskId, 'clarification', '是否继续保留归档？', 'ask-next');
    await app.inbox.decide(next.requestId, { commandId: 'answer-next', revision: next.revision, decision: 'answer', answer: '继续保留归档。' });
    await app.taskExecution.idle();
    const nextText = prompts(adapter)[2]!.text;
    assert.ok(nextText.includes('继续保留归档。'));
    assert.ok(!nextText.includes(answer));
    assert.ok(!nextText.includes(request.requestId));
    assertIncremental(nextText, task);
  });
});

test('多条 Inbox 请求全部处理后统一追加各自回应，不丢掉较早回答', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async (app, adapter) => {
    const task = await start(app);
    const first = app.humanRequests.create(task.taskId, 'recovery', '是否沿用原检查点？', 'ask-checkpoint');
    const second = app.humanRequests.create(task.taskId, 'clarification', '保留几天？', 'ask-days');
    await app.inbox.decide(first.requestId, { commandId: 'checkpoint', revision: 1, decision: 'continue', answer: '沿用原检查点。' });
    await app.taskExecution.idle(); assert.equal(prompts(adapter).length, 1);
    await app.inbox.decide(second.requestId, { commandId: 'days', revision: 1, decision: 'answer', answer: '保留 7 天。' });
    await app.taskExecution.idle();
    const text = prompts(adapter)[1]!.text;
    assert.ok(text.includes('沿用原检查点。')); assert.ok(text.includes('保留 7 天。'));
    assert.ok(text.includes(first.requestId)); assert.ok(text.includes(second.requestId));
    assertIncremental(text, task);
  });
});

test('执行中发起澄清并停止后，Inbox 回应继续原会话且不重复任务信息', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async (app, adapter) => {
    const task = app.tasks.create(taskInput).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const request = app.humanRequests.create(task.taskId, 'clarification', '采用哪个日志来源？', 'ask-running');
    adapter.releasePromptCompletionBarrier();
    await app.taskExecution.idle();
    const previous = app.tasks.detail(task.taskId).runs![0]!;
    assert.equal(previous.stopConfirmed, true);
    await app.inbox.decide(request.requestId, { commandId: 'answer', revision: 1, decision: 'answer', answer: '采用项目日志。' });
    await app.taskExecution.idle();
    assert.equal(prompts(adapter).length, 2);
    const sent = prompts(adapter)[1]!;
    assert.equal(sent.assistantSessionId, previous.sessionId);
    assertIncremental(sent.text, task);
  });
});

for (const fresh of ['restart', 'boundary'] as const) test(`Inbox 回应后${fresh === 'restart' ? '安全重做' : '任务边界变化'}使用新会话并保留完整任务信息`, { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async (app, adapter) => {
    const task = await start(app);
    const first = app.tasks.detail(task.taskId).runs![0]!;
    if (fresh === 'boundary') {
      await app.taskExecution.control(task.taskId, { commandId: 'pause', revision: task.revision, action: 'pause' });
      app.tasks.update(task.taskId, { commandId: 'change-goal', revision: app.tasks.get(task.taskId).revision, patch: { goal: '修改后的新目标，须完整提供。' } });
    }
    const request = app.humanRequests.create(task.taskId, fresh === 'restart' ? 'recovery' : 'clarification', '确认后继续？', 'ask');
    await app.inbox.decide(request.requestId, { commandId: 'answer', revision: 1, decision: fresh === 'restart' ? 'restart' : 'answer', answer: '保留已有文件，按当前目标继续。' });
    if (fresh === 'boundary') await app.taskExecution.control(task.taskId, { commandId: 'resume', revision: app.tasks.get(task.taskId).revision, action: 'resume' });
    await app.taskExecution.idle();
    const sent = prompts(adapter)[1]!;
    assert.notEqual(sent.assistantSessionId, first.sessionId);
    assert.ok(sent.text.includes(app.tasks.get(task.taskId).goal));
    assert.ok(sent.text.includes(task.scope)); assert.ok(sent.text.includes(task.acceptanceCriteria));
    assert.match(sent.text, /commit_task_code|submit_task_result/);
    assert.ok(sent.text.includes('保留已有文件，按当前目标继续。'));
  });
});

test('Inbox 回应不解除用户暂停，稍后手动继续仍读取持久化回应', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async (app, adapter) => {
    const task = await start(app);
    await app.taskExecution.control(task.taskId, { commandId: 'pause', revision: task.revision, action: 'pause' });
    const request = app.humanRequests.create(task.taskId, 'clarification', '是否采用这个来源？', 'ask');
    await app.inbox.decide(request.requestId, { commandId: 'answer', revision: 1, decision: 'answer', answer: '采用此来源。' });
    await app.taskExecution.idle();
    assert.equal(prompts(adapter).length, 1); assert.equal(app.tasks.get(task.taskId).pauseSource, 'user');
    await app.taskExecution.control(task.taskId, { commandId: 'resume', revision: app.tasks.get(task.taskId).revision, action: 'resume' });
    await app.taskExecution.idle();
    assert.ok(prompts(adapter)[1]!.text.includes('采用此来源。'));
    assertIncremental(prompts(adapter)[1]!.text, task);
  });
});

test('Inbox 回应在调度排队后仍从已保存的请求装配短消息', { skip: process.platform !== 'darwin' }, async () => {
  await fixture(async (app, adapter) => {
    const task = await start(app);
    app.taskScheduler.stopScheduling();
    const request = app.humanRequests.create(task.taskId, 'clarification', '日志采用哪种格式？', 'ask');
    await app.inbox.decide(request.requestId, { commandId: 'answer', revision: 1, decision: 'answer', answer: '采用 JSON 格式。' });
    const queued = app.tasks.get(task.taskId);
    assert.equal(queued.status, 'queued'); assert.equal(prompts(adapter).length, 1);
    app.taskExecution.startQueued(queued.currentRunId!); await app.taskExecution.idle();
    assert.equal(prompts(adapter).length, 2);
    assertIncremental(prompts(adapter)[1]!.text, task);
    assert.ok(prompts(adapter)[1]!.text.includes('采用 JSON 格式。'));
  });
});
