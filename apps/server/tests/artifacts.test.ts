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
