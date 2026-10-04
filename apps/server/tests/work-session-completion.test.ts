import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'work-task-completion-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  await app.ready;
  let sequence = 0;
  const commandId = () => `command-${++sequence}`;
  const create = (acceptance = true, dependencyIds: string[] = []) => app.tasks.create({ commandId: commandId(), title: '手动工作', goal: '核对两个来源并整理报告', acceptance, dependencyIds }).task;
  const complete = (taskId: string, summary = '已比较两个来源，核对引用，报告位于工作目录 report.md。') => app.humanRequests.completeSession(taskId, { commandId: commandId(), revision: app.tasks.get(taskId).revision, summary }, 'work-session');
  return { app, commandId, create, complete, async close() { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('手动任务无需验收时完成，记录来源与说明，版本和重放不重复改变事实', async () => {
  const f = await fixture();
  try {
    const task = f.create(false);
    const input = { commandId: f.commandId(), revision: task.revision, summary: '结果已核对，文件：report.md' };
    const completed = f.app.humanRequests.completeSession(task.taskId, input, 'work-session');
    assert.equal(completed.task.status, 'done');
    assert.ok(completed.task.completedAt);
    assert.equal(completed.task.completionReport?.sessionId, 'work-session');
    assert.equal(completed.task.completionReport?.summary, input.summary);
    assert.equal(completed.task.currentRunId, null);
    assert.equal(completed.task.sessionId, null);
    assert.equal(f.app.tasks.detail(task.taskId).runs?.length, 0);
    assert.equal(f.app.humanRequests.list(task.taskId).length, 0);
    assert.deepEqual(f.app.humanRequests.completeSession(task.taskId, input, 'work-session'), completed);
    assert.throws(() => f.app.humanRequests.completeSession(task.taskId, { ...input, summary: '不同内容' }, 'work-session'), /不同|冲突/);
    assert.throws(() => f.complete(task.taskId), /不能提交/);
    assert.equal(f.app.tasks.get(task.taskId).revision, completed.task.revision);
  } finally { await f.close(); }
});

test('完成说明绑定验收：修改后保持暂停，再提交新报告，旧决定不能接受新候选', async () => {
  const f = await fixture();
  try {
    const task = f.create();
    const first = f.complete(task.taskId).task;
    assert.equal(first.status, 'review');
    assert.equal(first.completedAt, null);
    const original = f.app.humanRequests.list(task.taskId)[0]!;
    assert.equal(original.completionReportId, first.completionReport?.reportId);
    assert.equal(original.sessionId, 'work-session');
    assert.equal(original.runId, null);
    await assert.rejects(f.app.humanRequests.decide(original.requestId, { commandId: f.commandId(), revision: 1, decision: 'changes' }), /修改意见/);
    await f.app.humanRequests.decide(original.requestId, { commandId: f.commandId(), revision: 1, decision: 'changes', answer: '补充来源日期' });
    assert.equal(f.app.tasks.get(task.taskId).status, 'paused');
    assert.equal(f.app.tasks.get(task.taskId).pauseSource, 'user');
    assert.equal(f.app.tasks.get(task.taskId).feedback, '补充来源日期');
    assert.equal(f.app.tasks.detail(task.taskId).runs?.length, 0);
    const second = f.complete(task.taskId, '已补充两个来源的日期，核对引用，更新 report.md。').task;
    assert.notEqual(second.completionReport?.reportId, first.completionReport?.reportId);
    await assert.rejects(f.app.humanRequests.decide(original.requestId, { commandId: f.commandId(), revision: 1, decision: 'accept' }), /已有不同决定/);
    const current = f.app.humanRequests.list(task.taskId).find((item) => item.status === 'pending')!;
    await f.app.humanRequests.decide(current.requestId, { commandId: f.commandId(), revision: 1, decision: 'accept' });
    assert.equal(f.app.tasks.get(task.taskId).status, 'done');
    assert.equal(f.app.humanRequests.list(task.taskId).length, 2);
    assert.ok(f.app.tasks.detail(task.taskId).events.some((event) => event.summary.includes('补充两个来源')));
  } finally { await f.close(); }
});

test('完成和验收不能绕过依赖、其他请求、版本、空说明或取消', async () => {
  const f = await fixture();
  try {
    const parent = f.create(false);
    const dependent = f.create(false, [parent.taskId]);
    assert.throws(() => f.complete(dependent.taskId), /前置任务/);
    assert.throws(() => f.complete(parent.taskId, '  '), /具体完成结果/);
    f.app.tasks.update(parent.taskId, { commandId: f.commandId(), revision: parent.revision, patch: { title: '新版标题' } });
    assert.throws(() => f.app.humanRequests.completeSession(parent.taskId, { commandId: f.commandId(), revision: parent.revision, summary: '已完成' }, 'work-session'), /已变化/);
    f.complete(parent.taskId);
    assert.equal(f.complete(dependent.taskId).task.status, 'done');
    const review = f.create();
    f.complete(review.taskId);
    const request = f.app.humanRequests.list(review.taskId)[0]!;
    f.app.humanRequests.create(review.taskId, 'clarification', '核对来源', f.commandId());
    await assert.rejects(f.app.humanRequests.decide(request.requestId, { commandId: f.commandId(), revision: 1, decision: 'accept' }), /状态已变化|待处理/);
    await f.app.taskExecution.control(review.taskId, { commandId: f.commandId(), revision: f.app.tasks.get(review.taskId).revision, action: 'cancel' });
    assert.throws(() => f.complete(review.taskId), /不能提交/);
    await assert.rejects(f.app.humanRequests.decide(request.requestId, { commandId: f.commandId(), revision: 1, decision: 'accept' }), /失效/);
  } finally { await f.close(); }
});

test('已有后台运行的任务不能用手动完成代替原成果流程', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture();
  try {
    const task = f.create(false);
    await f.app.taskExecution.control(task.taskId, { commandId: f.commandId(), revision: task.revision, action: 'start' });
    await f.app.taskExecution.idle();
    await f.app.taskExecution.control(task.taskId, { commandId: f.commandId(), revision: f.app.tasks.get(task.taskId).revision, action: 'pause' });
    assert.throws(() => f.complete(task.taskId), /已有后台运行/);
    assert.equal(f.app.tasks.get(task.taskId).status, 'paused');
  } finally { await f.close(); }
});

test('前置审核中允许后续手动完成及验收，不将审核中的子任务计为完成', async () => {
  const f = await fixture();
  try {
    const before = f.create();
    const first = f.create(false, [before.taskId]);
    const second = f.create(true, [before.taskId]);
    f.complete(before.taskId);
    assert.equal(f.app.tasks.get(before.taskId).status, 'review');
    assert.equal(f.app.tasks.relations(first.taskId).summary.dependencies.done, 1);
    assert.equal(f.complete(first.taskId).task.status, 'done');
    assert.equal(f.complete(second.taskId).task.status, 'review');
    const review = f.app.humanRequests.list(second.taskId)[0]!;
    await f.app.humanRequests.decide(review.requestId, { commandId: f.commandId(), revision: 1, decision: 'accept' });
    assert.equal(f.app.tasks.get(second.taskId).status, 'done');
    assert.equal(f.app.tasks.get(before.taskId).status, 'review');
    const parent = f.create();
    const child = f.app.tasks.create({ commandId: f.commandId(), title: '子任务', goal: '交付', parentTaskId: parent.taskId }).task;
    f.complete(child.taskId);
    assert.deepEqual(f.app.tasks.relations(parent.taskId).summary.children, { total: 1, done: 0, cancelled: 0 });
  } finally { await f.close(); }
});
