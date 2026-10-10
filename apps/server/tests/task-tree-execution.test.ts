import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tree-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  await app.ready;
  return { root, app, adapter, async close() { await app.taskExecution.idle(); await app.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(check(), '等待任务成果结算超时');
}

test('父任务单会话按依赖交付多级子任务，运行停止前候选不等于完成', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const { app, adapter } = f;
  try {
    const root = app.tasks.create({ commandId: 'root', title: '整体报告', goal: '整合', acceptance: true, acceptanceCriteria: '非空文本' }).task;
    const branch = app.tasks.create({ commandId: 'branch', title: '分支整合', goal: '整合分支', parentTaskId: root.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const a = app.tasks.create({ commandId: 'a', title: '资料', goal: '整理', parentTaskId: branch.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const b = app.tasks.create({ commandId: 'b', title: '验证', goal: '验证', parentTaskId: root.taskId, dependencyIds: [branch.taskId], acceptance: true }).task;
    adapter.armPromptCompletionBarrier();
    const input = { commandId: 'start', revision: root.revision, action: 'start' as const };
    const receipt = await app.taskExecution.control(root.taskId, input);
    assert.deepEqual(await app.taskExecution.control(root.taskId, input), receipt);
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(root.taskId).runs![0]!;
    assert.equal(run.treeTasks?.length, 3);
    const prompt = adapter.calls.find(call => call.method === 'prompt' && call.assistantSessionId === run.sessionId);
    assert.ok(prompt?.method === 'prompt');
    assert.match(prompt.text, /开始处理每个子任务前先调用 report_task_child/);
    assert.match(prompt.text, /每完成一个有代码改动的子任务.*本地提交，再调用 report_task_child/s);
    assert.match(prompt.text, /没有改动不创建空提交，非 Git 目录不初始化仓库/);
    assert.match(prompt.text, /用户明确要求不提交或指定其他提交策略时遵循用户要求/);
    const created = adapter.calls.find(call => call.method === 'createSession' && call.input.assistantSessionId === run.sessionId);
    assert.ok(created?.method === 'createSession');
    const tools = created.input.internalTools!;
    const treeRead = await tools.invoke({ assistantSessionId: run.sessionId, toolName: 'get_task_execution_tree', toolCallId: 'read-tree', args: { limit: 1 } }, new AbortController().signal);
    assert.equal(treeRead.ok, true);
    const progress = await tools.invoke({ assistantSessionId: run.sessionId, toolName: 'report_task_child', toolCallId: 'record-progress', args: { taskId: a.taskId, summary: '正在核对资料' } }, new AbortController().signal);
    assert.equal(progress.ok, true);
    assert.equal(app.tasks.get(a.taskId).executionProgress, 'processing');
    assert.equal(app.tasks.get(b.taskId).executionProgress, 'pending');

    assert.equal(app.tasks.detail(a.taskId).runs?.length, 0);
    assert.equal(app.tasks.get(a.taskId).sessionId, run.sessionId);
    await assert.rejects(app.taskExecution.control(a.taskId, { commandId: 'duplicate', revision: app.tasks.get(a.taskId).revision, action: 'start' }), /父任务/);
    assert.throws(() => app.tasks.update(a.taskId, { commandId: 'edit', revision: app.tasks.get(a.taskId).revision, patch: { goal: '越界修改' } }), /父任务|先安全停止/);
    assert.throws(() => app.artifacts.reportChild(run.sessionId, 'early', b.taskId, '提前执行'), /前置/);
    assert.throws(() => app.artifacts.registerSession(run.sessionId, 'early-root', '整体', 'root.md'), /仍有子任务/);
    for (const task of [a, branch, b]) {
      await writeFile(join(run.directory!.path, `${task.taskId}.md`), `真实成果 ${task.title}`);
      app.artifacts.reportChild(run.sessionId, `report-${task.taskId}`, task.taskId, `已完成 ${task.title} 的实现与核验`, task.title, `${task.taskId}.md`);
      assert.equal(app.tasks.get(task.taskId).status, 'waiting');
      assert.equal(app.tasks.get(task.taskId).executionProgress, 'ready');
    }
    // 执行中新建的任务不进入本次固定范围。
    const later = app.tasks.create({ commandId: 'later', title: '新增工作', goal: '之后处理', parentTaskId: root.taskId }).task;
    assert.equal((await app.artifacts.executionTree(run.sessionId)).total, 3);
    assert.throws(() => app.artifacts.reportChild(run.sessionId, 'outside', later.taskId, '越界'), /不属于/);
    await writeFile(join(run.directory!.path, 'root.md'), '整体核验完成');
    app.artifacts.registerSession(run.sessionId, 'report-root', '整体成果', 'root.md');
    adapter.releasePromptCompletionBarrier();
    await app.taskExecution.idle();
    await until(() => app.tasks.get(root.taskId).status === 'review');
    assert.equal(app.tasks.get(a.taskId).status, 'done');
    assert.equal(app.tasks.get(branch.taskId).status, 'done');
    assert.equal(app.tasks.get(b.taskId).status, 'review');
    assert.equal(app.tasks.get(later.taskId).status, 'idle');
    assert.equal(app.tasks.detail(root.taskId).runs!.length, 1);
    assert.equal(app.artifacts.list(b.taskId)[0]!.runId, run.runId);
    assert.equal(app.humanRequests.list(b.taskId)[0]!.runId, run.runId);
    assert.equal((await app.artifacts.read(app.artifacts.list(a.taskId)[0]!.versionId)).content, '真实成果 资料');
    const rootReview = app.humanRequests.list(root.taskId).find(item => item.kind === 'review' && item.status === 'pending')!;
    const childReview = app.humanRequests.list(b.taskId).find(item => item.kind === 'review' && item.status === 'pending')!;
    await app.humanRequests.decide(childReview.requestId, { commandId: 'return-child', revision: childReview.revision, decision: 'changes', answer: '补充证据' });
    assert.equal(app.tasks.get(root.taskId).status, 'paused');
    assert.equal(app.humanRequests.get(rootReview.requestId).status, 'invalidated');
    assert.equal(app.tasks.detail(b.taskId).runs!.length, 0);

  } finally { adapter.releasePromptCompletionBarrier(); await f.close(); }
});

test('固定范围跨分页、依赖循环拒绝且不产生半份运行', async () => {
  const f = await fixture(); const { app } = f;
  try {
    const root = app.tasks.create({ commandId: 'root', title: '大任务', goal: '核对' }).task;
    for (let i = 0; i < 105; i++) app.tasks.create({ commandId: `c-${i}`, title: `子项 ${i}`, goal: '核对', parentTaskId: root.taskId });
    assert.equal(app.tasks.descendants(root.taskId).length, 105);
    const child = app.tasks.list({ parentTaskId: root.taskId, limit: 1 }).tasks[0]!;
    app.tasks.update(child.taskId, { commandId: 'cycle', revision: child.revision, patch: { dependencyIds: [root.taskId] } });
    await assert.rejects(app.taskExecution.control(root.taskId, { commandId: 'start', revision: root.revision, action: 'start' }), /循环/);
    assert.equal(app.tasks.detail(root.taskId).runs!.length, 0);
    assert.equal(app.tasks.get(child.taskId).currentRunId, null);
  } finally { await f.close(); }
});

test('人工子任务不得由父会话报告完成，未满足时不能交付整体成果', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const { app, adapter } = f;
  try {
    const root = app.tasks.create({ commandId: 'root', title: '含人工工作', goal: '核验' }).task;
    const before = app.tasks.create({ commandId: 'before', title: '准备人工资料', goal: '准备', parentTaskId: root.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const human = app.tasks.create({ commandId: 'human', title: '用户确认', goal: '用户处理', parentTaskId: root.taskId, dependencyIds: [before.taskId], humanOnly: true }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(root.taskId, { commandId: 'start', revision: root.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(root.taskId).runs![0]!;
    assert.throws(() => app.artifacts.reportChild(run.sessionId, 'fake', human.taskId, '完成'), /不能/);
    assert.throws(() => app.artifacts.registerSession(run.sessionId, 'fake-root', '报告', 'root.md'), /仍有子任务/);
    await writeFile(join(run.directory!.path, 'before.md'), '可供用户核对的资料');
    app.artifacts.reportChild(run.sessionId, 'before-result', before.taskId, '资料已准备', '资料', 'before.md');
    adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle();
    await until(() => app.tasks.get(before.taskId).status === 'done');
    assert.equal(app.tasks.get(root.taskId).status, 'waiting');
    app.tasks.confirmHumanCompletion(human.taskId, { commandId: 'user-confirmed', revision: human.revision });
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(root.taskId, { commandId: 'resume-after-human', revision: app.tasks.get(root.taskId).revision, action: 'resume' });
    await adapter.waitForPromptCompletionBarrierEntry();
    await writeFile(join(run.directory!.path, 'root.md'), '用户确认后整体核验');
    app.artifacts.registerSession(run.sessionId, 'root-result', '报告', 'root.md');
    adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle();
    await until(() => app.tasks.get(root.taskId).status === 'review');
  } finally { adapter.releasePromptCompletionBarrier(); await f.close(); }
});


test('暂停恢复沿用父会话与候选，取消确认停止后释放子任务', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const { app, adapter } = f;
  try {
    const root = app.tasks.create({ commandId: 'root', title: '恢复工作', goal: '核验', acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const child = app.tasks.create({ commandId: 'child', title: '阶段成果', goal: '核验', parentTaskId: root.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const working = app.tasks.create({ commandId: 'working', title: '正在处理的子项', goal: '继续', parentTaskId: root.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(root.taskId, { commandId: 'start', revision: root.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const first = app.tasks.detail(root.taskId).runs![0]!;
    await writeFile(join(first.directory!.path, 'child.md'), '暂停前保留的候选');
    app.artifacts.reportChild(first.sessionId, 'child-result', child.taskId, '登记候选', '子项成果', 'child.md');
    app.artifacts.reportChild(first.sessionId, 'working-start', working.taskId, '开始处理');
    assert.equal(app.tasks.get(working.taskId).executionProgress, 'processing');
    const pausing = app.taskExecution.control(root.taskId, { commandId: 'pause', revision: app.tasks.get(root.taskId).revision, action: 'pause' });
    adapter.releasePromptCompletionBarrier(); await pausing; await app.taskExecution.idle();
    assert.equal(app.tasks.get(root.taskId).status, 'paused');
    assert.equal(app.artifacts.list(child.taskId).length, 0);
    assert.equal(app.tasks.get(working.taskId).executionProgress, 'paused');
    assert.equal(app.tasks.get(child.taskId).executionProgress, 'ready');
    await assert.rejects(app.taskExecution.control(child.taskId, { commandId: 'duplicate-paused', revision: app.tasks.get(child.taskId).revision, action: 'resume' }), /父任务/);
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(root.taskId, { commandId: 'resume', revision: app.tasks.get(root.taskId).revision, action: 'resume' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const second = app.tasks.detail(root.taskId).runs![0]!;
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.directory!.path, first.directory!.path);
    assert.equal(second.childResults?.length, 1);
    assert.equal(app.tasks.get(child.taskId).executionProgress, 'ready');
    assert.equal(app.tasks.get(working.taskId).executionProgress, 'pending');
    await writeFile(join(second.directory!.path, 'working.md'), '恢复后完成的子项');
    app.artifacts.reportChild(second.sessionId, 'working-result', working.taskId, '已处理', '子项成果', 'working.md');
    assert.notEqual(second.childResults![0]!.commandId, first.childResults?.[0]?.commandId);
    await writeFile(join(second.directory!.path, 'root.md'), '整体结果');
    app.artifacts.registerSession(second.sessionId, 'whole-result', '整体结果', 'root.md');
    adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle();
    await until(() => app.tasks.get(root.taskId).status === 'done');
    assert.equal(app.tasks.get(child.taskId).status, 'done');
    assert.equal(app.tasks.detail(child.taskId).runs!.length, 0);

    const nextRoot = app.tasks.create({ commandId: 'next-root', title: '取消工作', goal: '核验' }).task;
    const nextChild = app.tasks.create({ commandId: 'next-child', title: '未完成子项', goal: '核验', parentTaskId: nextRoot.taskId }).task;
    await app.taskExecution.control(nextRoot.taskId, { commandId: 'next-start', revision: nextRoot.revision, action: 'start' });
    await app.taskExecution.control(nextRoot.taskId, { commandId: 'next-cancel', revision: app.tasks.get(nextRoot.taskId).revision, action: 'cancel' });
    await app.taskExecution.idle();
    assert.equal(app.tasks.get(nextChild.taskId).status, 'paused');
    assert.equal(app.tasks.get(nextChild.taskId).executionTaskId, undefined);
    assert.equal(app.tasks.executionOwner(nextChild.taskId), null);
  } finally { adapter.releasePromptCompletionBarrier(); await f.close(); }
});


test('重启补齐已停止运行的子任务候选，不重新启动模型', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-tree-recovery-'));
  const adapter = new FakeCoordinatorAdapter();
  let app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  try {
    await app.ready;
    const parent = app.tasks.create({ commandId: 'root', title: '恢复交付', goal: '核验', acceptance: false, acceptanceCriteria: '非空文本' }).task;
    const child = app.tasks.create({ commandId: 'child', title: '已做工作', goal: '核验', parentTaskId: parent.taskId, acceptance: false, acceptanceCriteria: '非空文本' }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(parent.taskId, { commandId: 'start', revision: parent.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(parent.taskId).runs![0]!;
    await writeFile(join(run.directory!.path, 'child.md'), '已完成子任务');
    await writeFile(join(run.directory!.path, 'parent.md'), '已完成整合');
    app.artifacts.reportChild(run.sessionId, 'child-result', child.taskId, '子任务已实现', '子项', 'child.md');
    app.artifacts.registerSession(run.sessionId, 'root-result', '整体', 'parent.md');
    // 模拟成果消费者在停止事实落盘前退出，下一服务只恢复文件核对。
    app.artifacts.dispose();
    adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle();
    assert.equal(app.tasks.get(parent.taskId).status, 'waiting');
    assert.equal(app.artifacts.list(child.taskId).length, 0);
    await app.close();
    const restarted = new FakeCoordinatorAdapter();
    app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: restarted });
    await app.ready;
    await until(() => app.tasks.get(parent.taskId).status === 'done');
    assert.equal(app.tasks.get(child.taskId).status, 'done');
    assert.equal(app.tasks.detail(parent.taskId).runs!.length, 1);
    assert.equal(app.tasks.detail(child.taskId).runs!.length, 0);
    assert.equal(restarted.calls.some(call => call.method === 'prompt'), false);
  } finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); await app.close(); await rm(root, { recursive: true, force: true }); }
});


test('真实任务会话带任务身份并排除栏位补位，工作会话和原现场保持独立', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const { app, adapter } = f;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  try {
    const work = await api('sessions', 'POST', { sessionId: 'work-layout', title: '普通工作会话' });
    const initial = await api('workspaces/default/scene');
    const before = await api('workspaces/default/scene', 'PUT', { ...initial.scene, slots: [work.sessionId], focusedSessionId: work.sessionId, viewMode: 'parallel' });
    const task = app.tasks.create({ commandId: 'task-layout', title: '独占任务', goal: '核对资料' }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(task.taskId, { commandId: 'start-layout', revision: task.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const run = app.tasks.detail(task.taskId).runs![0]!;
    assert.equal((await api('sessions')).sessions.find((item: { sessionId: string }) => item.sessionId === run.sessionId)?.taskId, task.taskId);
    assert.equal((await api('sessions')).sessions.find((item: { sessionId: string }) => item.sessionId === work.sessionId)?.taskId, undefined);
    assert.deepEqual(await api('workspaces/default/scene'), before);
    const requested = await api('workspaces/default/scene', 'PUT', { ...before.scene, slots: [work.sessionId, run.sessionId], focusedSessionId: run.sessionId });
    assert.deepEqual(requested.scene.slots, [work.sessionId]);
    assert.equal(requested.scene.focusedSessionId, null);
    adapter.releasePromptCompletionBarrier();
    await app.taskExecution.idle();
    assert.equal((await api('sessions')).sessions.find((item: { sessionId: string }) => item.sessionId === run.sessionId)?.taskId, task.taskId);
  } finally {
    adapter.releasePromptCompletionBarrier();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await f.close();
  }
});
