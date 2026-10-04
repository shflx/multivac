import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('安全重做保留目录与变更，使用新会话，不重放旧命令', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-redo-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'redo-create', title: '重做核对', goal: '核对已有成果' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'redo-start', revision: 1, action: 'start' }); await app.taskExecution.idle();
    const first = app.tasks.detail(task.taskId).runs![0]!;
    await writeFile(join(first.directory!.path, 'keep.txt'), '用户已有变更');
    const request = app.humanRequests.create(task.taskId, 'recovery', '核对后重做？', 'redo-ask');
    assert.equal(app.humanRequests.get(request.requestId).recovery?.canResume, true);
    const input = { commandId: 'redo-decide', revision: 1, decision: 'restart' as const };
    await app.humanRequests.decide(request.requestId, input); await app.taskExecution.idle();
    const next = app.tasks.detail(task.taskId).runs![0]!;
    assert.notEqual(next.sessionId, first.sessionId); assert.notEqual(next.commandId, first.commandId);
    assert.deepEqual(next.directory, first.directory);
    assert.equal(await readFile(join(next.directory!.path, 'keep.txt'), 'utf8'), '用户已有变更');
    await app.humanRequests.decide(request.requestId, input);
    assert.equal(app.tasks.detail(task.taskId).runs!.length, 2);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('结构化范围采用固定内容，保持用户暂停且不能当作目录授权', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-scope-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'scope-create', title: '范围核对', goal: '核对来源' }).task;
    const scope = { materials: ['项目报告'], scope: '仅摘要', purpose: '交叉核对', evidence: '用户提供的项目报告' };
    const request = app.humanRequests.create(task.taskId, 'clarification', '是否引用？', 'scope-ask', null, undefined, scope);
    await app.taskExecution.control(task.taskId, { commandId: 'scope-pause', revision: app.tasks.get(task.taskId).revision, action: 'pause' });
    await assert.rejects(app.humanRequests.decide(request.requestId, { commandId: 'empty', revision: 1, decision: 'answer', answer: '  ' }), /填写回应/);
    const result = await app.humanRequests.decide(request.requestId, { commandId: 'scope-answer', revision: 1, decision: 'use_scope' });
    assert.match(result.answer, /仅摘要/); assert.match(result.answer, /不扩大文件访问权限/);
    assert.equal(app.tasks.get(task.taskId).pauseSource, 'user');
    assert.equal(app.tasks.get(task.taskId).currentRunId, null);
    assert.throws(() => app.humanRequests.create(task.taskId, 'clarification', '是否引用？', 'scope-ask', null, undefined, { ...scope, scope: '全部' }), /不同内容/);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('澄清版本、重复答复、取消失效与用户暂停按持久事实处理', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-request-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    let task = app.tasks.create({ commandId: 'create', title: '请求核对', goal: '核对来源' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' }); await app.taskExecution.idle();
    const request = app.humanRequests.create(task.taskId, 'clarification', '需要采用哪个来源？', 'ask');
    assert.deepEqual(app.humanRequests.create(task.taskId, 'clarification', '需要采用哪个来源？', 'ask'), request);
    task = app.tasks.get(task.taskId);
    await assert.rejects(app.taskExecution.control(task.taskId, { commandId: 'bypass', revision: task.revision, action: 'resume' }), /原人工请求/);
    await assert.rejects(app.humanRequests.decide(request.requestId, { commandId: 'stale', revision: 2, decision: 'answer', answer: '来源 A' }), /已变化/);
    await app.taskExecution.control(task.taskId, { commandId: 'pause', revision: task.revision, action: 'pause' });
    const input = { commandId: 'answer', revision: 1, decision: 'answer' as const, answer: '来源 A' };
    const decided = await app.humanRequests.decide(request.requestId, input);
    assert.equal(decided.status, 'answered');
    assert.deepEqual(await app.humanRequests.decide(request.requestId, input), decided);
    assert.equal(app.tasks.get(task.taskId).status, 'paused');
    assert.equal(app.tasks.get(task.taskId).pauseSource, 'user');
    assert.equal(app.tasks.detail(task.taskId).runs?.length, 1);
    const second = app.humanRequests.create(task.taskId, 'clarification', '还需要补充吗？', 'ask-next');
    await app.taskExecution.control(task.taskId, { commandId: 'cancel', revision: app.tasks.get(task.taskId).revision, action: 'cancel' });
    assert.equal(app.humanRequests.get(second.requestId).status, 'invalidated');
    await assert.rejects(app.humanRequests.decide(second.requestId, { commandId: 'late', revision: second.revision, decision: 'answer', answer: '继续' }), /失效/);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('有效澄清恢复同一上下文，输入内容不扩大执行目录', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-human-resume-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'c', title: '恢复上下文', goal: '核对来源' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 's', revision: 1, action: 'start' }); await app.taskExecution.idle();
    const first = app.tasks.detail(task.taskId).runs![0]!;
    const request = app.humanRequests.create(task.taskId, 'clarification', '引用范围？', 'ask');
    await app.humanRequests.decide(request.requestId, { commandId: 'd', revision: 1, decision: 'answer', answer: '仅采用项目文档' });
    await app.taskExecution.idle();
    const second = app.tasks.detail(task.taskId).runs![0]!;
    assert.equal(app.tasks.detail(task.taskId).runs!.length, 2, JSON.stringify({ task: app.tasks.get(task.taskId), run: second }));
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(second.directory, first.directory);
    const prompts = adapter.calls.filter((call) => call.method === 'prompt');
    assert.ok(prompts.some((call) => 'text' in call && call.text.includes('仅采用项目文档')));
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});
