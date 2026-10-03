import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

test('真实成果文件固定版本、要求修改、新版本验收与取消历史', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-artifact-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'c', title: '报告', goal: '核对来源', acceptance: true }).task;
    await app.taskExecution.control(task.taskId, { commandId: 's', revision: 1, action: 'start' }); await app.taskExecution.idle();
    let run = app.tasks.detail(task.taskId).runs![0]!;
    await writeFile(join(run.directory!.path, 'report.md'), '# 第一版\n实际报告');
    const first = await app.artifacts.submit(task.taskId, { commandId: 'v1', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '核对报告', path: 'report.md' });
    assert.equal(app.tasks.get(task.taskId).status, 'review');
    assert.equal((await app.artifacts.read(first.versionId)).content, '# 第一版\n实际报告');
    await writeFile(join(run.directory!.path, 'report.md'), '原文件已修改');
    assert.equal((await app.artifacts.read(first.versionId)).content, '# 第一版\n实际报告');
    const request = app.humanRequests.list(task.taskId).find((item) => item.status === 'pending' && item.kind === 'review')!;
    await app.humanRequests.decide(request.requestId, { commandId: 'changes', revision: request.revision, decision: 'changes', answer: '补充来源说明' });
    await app.taskExecution.idle();
    assert.equal(app.artifacts.get(first.versionId).status, 'changes');
    assert.equal(app.artifacts.get(first.versionId).feedback, '补充来源说明');
    run = app.tasks.detail(task.taskId).runs![0]!;
    await writeFile(join(run.directory!.path, 'report.md'), '# 第二版\n已补充来源说明');
    const second = await app.artifacts.submit(task.taskId, { commandId: 'v2', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '核对报告', path: 'report.md' });
    assert.equal(second.version, 2);
    assert.notEqual(second.sha256, first.sha256);
    const review = app.humanRequests.list(task.taskId).find((item) => item.status === 'pending' && item.kind === 'review')!;
    await app.humanRequests.decide(review.requestId, { commandId: 'accept', revision: review.revision, decision: 'accept' });
    assert.equal(app.tasks.get(task.taskId).status, 'done');
    assert.equal(app.artifacts.get(second.versionId).status, 'accepted');
    assert.equal(app.artifacts.list(task.taskId).length, 2);
    assert.equal((await app.artifacts.read(first.versionId)).content, '# 第一版\n实际报告');
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('自检只使用已声明的服务端规则，模型完成文字不能完成任务', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-artifact-check-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'c', title: 'JSON 输出', goal: '生成数据', acceptance: false, acceptanceCriteria: '有效 JSON' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 's', revision: 1, action: 'start' }); await app.taskExecution.idle();
    assert.equal(app.tasks.get(task.taskId).status, 'waiting');
    const run = app.tasks.detail(task.taskId).runs![0]!;
    const version = await app.artifacts.submit(task.taskId, { commandId: 'v', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '数据', text: '{"verified":true}' });
    assert.equal(app.tasks.get(task.taskId).status, 'done');
    assert.equal(version.status, 'accepted');
    assert.equal(version.sourceKind, 'user-text');
    assert.equal(version.checks.at(-1)?.name, '有效 JSON');
    await assert.rejects(app.artifacts.submit(task.taskId, { commandId: 'overwrite', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '覆盖', text: '坏数据' }), /已完成/);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('验收不能绕过其他待处理请求，新版本使旧验收请求失效', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-artifact-pending-'));
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: new FakeCoordinatorAdapter() });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'create', title: '验收门禁', goal: '核对报告' }).task;
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' }); await app.taskExecution.idle();
    const run = app.tasks.detail(task.taskId).runs![0]!;
    await app.taskExecution.control(task.taskId, { commandId: 'user-pause', revision: app.tasks.get(task.taskId).revision, action: 'pause' });
    const first = await app.artifacts.submit(task.taskId, { commandId: 'version-1', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '报告', text: '第一版事实' });
    const oldReview = app.humanRequests.list(task.taskId).find((item) => item.kind === 'review' && item.status === 'pending')!;
    const clarification = app.humanRequests.create(task.taskId, 'clarification', '采用哪份来源？', 'clarification');
    await assert.rejects(app.humanRequests.decide(oldReview.requestId, { commandId: 'unsafe-accept', revision: oldReview.revision, decision: 'accept' }), /其他待处理请求/);
    assert.equal(app.artifacts.get(first.versionId).status, 'submitted');
    assert.equal(app.humanRequests.get(oldReview.requestId).status, 'pending');
    await app.humanRequests.decide(clarification.requestId, { commandId: 'answer', revision: clarification.revision, decision: 'answer', answer: '采用资料 A' });
    // 回应澄清后执行已停下；新候选仍应能审核，不能留下无法处理的旧请求。
    const second = await app.artifacts.submit(task.taskId, { commandId: 'version-2', revision: app.tasks.get(task.taskId).revision, runId: run.runId, title: '报告', text: '第二版事实' });
    assert.equal(app.humanRequests.get(oldReview.requestId).status, 'invalidated');
    assert.match(app.humanRequests.get(oldReview.requestId).reason, /新成果版本/);
    assert.equal(app.artifacts.get(first.versionId).status, 'submitted');
    assert.equal((await app.artifacts.read(first.versionId)).content, '第一版事实');
    assert.equal(second.version, 2);
    const review = app.humanRequests.list(task.taskId).find((item) => item.kind === 'review' && item.status === 'pending')!;
    assert.equal(app.tasks.get(task.taskId).status, 'paused');
    assert.equal(app.tasks.get(task.taskId).pauseSource, 'user');
    assert.equal(app.tasks.detail(task.taskId).runs!.length, 1);
    assert.equal(review.artifactVersionId, second.versionId);
    await app.humanRequests.decide(review.requestId, { commandId: 'accept-current', revision: review.revision, decision: 'accept' });
    assert.equal(app.tasks.get(task.taskId).status, 'done');
    await assert.rejects(app.humanRequests.decide(oldReview.requestId, { commandId: 'late', revision: oldReview.revision, decision: 'accept' }), /失效/);
  } finally { await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});

test('模型登记不存在的成果文件时，失败原因写回任务，不静默停留在等待成果', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-artifact-auto-error-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  try {
    await app.ready;
    const task = app.tasks.create({ commandId: 'create', title: '失败的成果提交', goal: '登记文件' }).task;
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: 1, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    app.artifacts.registerSession(app.tasks.get(task.taskId).sessionId!, 'missing-result', '报告', 'missing.md');
    adapter.releasePromptCompletionBarrier();
    await app.taskExecution.idle();
    for (let attempt = 0; attempt < 100 && app.tasks.get(task.taskId).status !== 'failed'; attempt++) await new Promise((done) => setTimeout(done, 5));
    assert.equal(app.tasks.get(task.taskId).status, 'failed');
    assert.match(app.tasks.get(task.taskId).reason, /未能保存或核对成果/);
    assert.equal(app.artifacts.list(task.taskId).length, 0);
    assert.equal(app.tasks.detail(task.taskId).runs![0]!.stopConfirmed, true);
  } finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); app.close(); await rm(root, { recursive: true, force: true }); }
});
