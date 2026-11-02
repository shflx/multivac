import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-attachments-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  await app.ready;
  return { app, adapter, root, async close() { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('暂存附件原子绑定任务；同名不覆盖、原请求重试、迟到上传及错误归属拒绝', async () => {
  const f = await fixture(); const { app } = f;
  try {
    const draftId = randomUUID(); const owner = { draftId }; const id = randomUUID();
    const first = await app.taskAttachments.upload(owner, id, '../../same.json', Buffer.from('{"answer":42}'));
    const second = await app.taskAttachments.upload(owner, randomUUID(), '../../same.json', Buffer.from('second'));
    assert.equal(first.capability, 'text'); assert.notEqual(first.id, second.id);
    assert.deepEqual(await app.taskAttachments.upload(owner, id, first.name, Buffer.from('{"answer":42}')), first);
    await assert.rejects(app.taskAttachments.upload(owner, id, first.name, Buffer.from('changed')), /身份已使用/);
    assert.throws(() => app.tasks.create({ commandId: 'bad-create', attachmentDraftId: draftId, title: '失败', goal: '保留输入', projectId: 'missing' }));
    assert.equal(app.taskAttachments.list(owner).length, 2);
    const input = { commandId: 'create', attachmentDraftId: draftId, title: '带材料', goal: '读取附件' };
    const task = app.tasks.create(input).task;
    assert.equal(app.tasks.create(input).task.taskId, task.taskId);
    assert.equal(app.tasks.detail(task.taskId).attachments?.length, 2);
    await assert.rejects(app.taskAttachments.upload(owner, randomUUID(), 'late.txt', Buffer.from('late')), /已绑定/);
    assert.throws(() => app.tasks.create({ ...input, commandId: 'other-create' }), /已绑定/);
    assert.equal(app.tasks.list().total, 1);
    const other = app.tasks.create({ commandId: 'other', title: '其他', goal: '不可读' }).task;
    await assert.rejects(app.taskAttachments.read({ taskId: other.taskId }, id), /不属于/);
    const { data } = await app.taskAttachments.read({ taskId: task.taskId }, id);
    assert.equal(data.toString(), '{"answer":42}');
    app.taskAttachments.remove({ taskId: task.taskId }, id);
    assert.equal(app.taskAttachments.list({ taskId: task.taskId }).length, 1);
    await assert.rejects(app.taskAttachments.read({ taskId: task.taskId }, id), /已移除/);
    assert.equal((await app.taskAttachments.readFixed({ ...first, taskId: task.taskId })).toString(), '{"answer":42}');
    assert.equal(app.artifacts.list(task.taskId).length, 0);
  } finally { await f.close(); }
});

test('内容核定图片、UTF-8 和仅下载；损坏图片与预算准确拒绝', async () => {
  const f = await fixture();
  try {
    const owner = { draftId: randomUUID() };
    const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
    const image = await f.app.taskAttachments.upload(owner, randomUUID(), 'fake.txt', png);
    assert.equal(image.mimeType, 'image/png'); assert.equal(image.capability, 'image');
    const binary = await f.app.taskAttachments.upload(owner, randomUUID(), 'fake.png', Buffer.from([255,0,1]));
    assert.equal(binary.capability, 'download');
    const pdf = await f.app.taskAttachments.upload(owner, randomUUID(), 'document.pdf', Buffer.from('%PDF-1.7\ntext'));
    assert.equal(pdf.capability, 'download');
    await assert.rejects(f.app.taskAttachments.upload(owner, randomUUID(), 'bad.png', png.subarray(0,12)), /图片无效/);
    await assert.rejects(f.app.taskAttachments.upload(owner, randomUUID(), 'big', Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MiB/);
    for (let i = 3; i < 20; i++) await f.app.taskAttachments.upload(owner, randomUUID(), 'same.txt', Buffer.from('ok'));
    await assert.rejects(f.app.taskAttachments.upload(owner, randomUUID(), 'over', Buffer.from('ok')), /20 个/);
    const full = { draftId: randomUUID() };
    for (let i = 0; i < 5; i++) await f.app.taskAttachments.upload(full, randomUUID(), 'large', Buffer.alloc(10 * 1024 * 1024, 65));
    await assert.rejects(f.app.taskAttachments.upload(full, randomUUID(), 'over', Buffer.from('x')), /50 MiB/);
  } finally { await f.close(); }
});

test('上传中不能消费暂存身份，执行及终态不能改动当前附件', async () => {
  const f = await fixture();
  try {
    const draftId = randomUUID();
    const upload = f.app.taskAttachments.upload({ draftId }, randomUUID(), 'input.txt', Buffer.from('input'));
    const input = { commandId: 'create', attachmentDraftId: draftId, title: '执行边界', goal: '核对' };
    assert.throws(() => f.app.tasks.create(input), /仍在上传/);
    await upload;
    const task = f.app.tasks.create(input).task;
    f.adapter.armPromptCompletionBarrier();
    await f.app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await assert.rejects(f.app.taskAttachments.upload({ taskId: task.taskId }, randomUUID(), 'late', Buffer.from('late')), /不能修改/);
    assert.throws(() => f.app.taskAttachments.remove({ taskId: task.taskId }, f.app.tasks.detail(task.taskId).attachments![0]!.id), /不能修改/);
    f.adapter.releasePromptCompletionBarrier(); await f.app.taskExecution.idle();
  } finally { await f.close(); }
});

test('入队固定父子范围；新子项不纳入，暂停继续沿用，安全重做采用新附件版本', async () => {
  const f = await fixture(); const { app } = f;
  try {
    const external = app.tasks.create({ commandId: 'external', title: '等待人工条件', goal: '阻止派发', humanOnly: true }).task;
    const root = app.tasks.create({ commandId: 'root', title: '父任务', goal: '整合', dependencyIds: [external.taskId] }).task;
    const child = app.tasks.create({ commandId: 'child', title: '子任务', goal: '处理', parentTaskId: root.taskId }).task;
    const rootInput = await app.taskAttachments.upload({ taskId: root.taskId }, randomUUID(), 'same.txt', Buffer.from('原输入'));
    const childInput = await app.taskAttachments.upload({ taskId: child.taskId }, randomUUID(), 'child.txt', Buffer.from('子项输入'));
    await app.taskExecution.control(root.taskId, { commandId: 'queue', revision: root.revision, action: 'start' });
    const original = app.tasks.detail(root.taskId).runs![0]!;
    assert.deepEqual(original.inputSnapshot?.attachments.map(item => item.id), [rootInput.id, childInput.id]);
    assert.equal(original.hasStarted, false);
    const later = app.tasks.create({ commandId: 'later', title: '新增子任务', goal: '之后', parentTaskId: root.taskId }).task;
    await app.taskAttachments.upload({ taskId: later.taskId }, randomUUID(), 'later.txt', Buffer.from('不进入原范围'));
    assert.equal(app.tasks.detail(root.taskId).runs![0]!.inputSnapshot!.attachments.length, 2);
    assert.equal(app.tasks.detail(child.taskId).inputHistory![0]!.inputSnapshot!.attachments[0]!.id, childInput.id);
    await app.taskExecution.control(root.taskId, { commandId: 'pause', revision: app.tasks.get(root.taskId).revision, action: 'pause' });
    app.taskAttachments.remove({ taskId: root.taskId }, rootInput.id);
    const replacement = await app.taskAttachments.upload({ taskId: root.taskId }, randomUUID(), 'same.txt', Buffer.from('新输入'));
    await app.taskExecution.control(root.taskId, { commandId: 'resume', revision: app.tasks.get(root.taskId).revision, action: 'resume' });
    const resumed = app.tasks.detail(root.taskId).runs![0]!;
    assert.deepEqual(resumed.inputSnapshot, original.inputSnapshot);
    assert.equal((await app.taskAttachments.readHistory(root.taskId, resumed.runId, rootInput.id)).data.toString(), '原输入');
    await assert.rejects(app.taskAttachments.readHistory(later.taskId, resumed.runId, rootInput.id), /不属于/);
    await assert.rejects(app.taskAttachments.readHistory(child.taskId, resumed.runId, rootInput.id), /不属于/);
    await app.taskExecution.control(root.taskId, { commandId: 'pause-again', revision: app.tasks.get(root.taskId).revision, action: 'pause' });
    const request = app.humanRequests.create(root.taskId, 'recovery', '核对后安全重做', 'recovery-inputs');
    await app.humanRequests.decide(request.requestId, { commandId: 'restart-inputs', revision: request.revision, decision: 'restart' });
    await app.taskExecution.control(root.taskId, { commandId: 'redo', revision: app.tasks.get(root.taskId).revision, action: 'resume' });
    const redo = app.tasks.detail(root.taskId).runs![0]!;
    assert.notEqual(redo.inputSnapshot!.snapshotId, original.inputSnapshot!.snapshotId);
    assert.deepEqual(redo.inputSnapshot!.attachments.map(item => item.id), [replacement.id, childInput.id]);
    assert.equal(redo.treeTasks!.length, 1);
    assert.equal((await app.taskAttachments.readHistory(root.taskId, original.runId, rootInput.id)).data.toString(), '原输入');
  } finally { await f.close(); }
});

test('原件损坏或缺失拒绝派发，不替换同名附件；暂停快照跨服务重启保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multivac-input-recovery-'));
  const env = testApplicationEnvironment(root);
  let adapter = new FakeCoordinatorAdapter();
  let app = createMultivacApplication(env, { coordinatorAdapter: adapter });
  await app.ready;
  try {
    const task = app.tasks.create({ commandId: 'task', title: '读取材料', goal: '读取实际内容' }).task;
    const input = await app.taskAttachments.upload({ taskId: task.taskId }, randomUUID(), 'source.txt', Buffer.from('original'));
    adapter.armPromptCompletionBarrier();
    await app.taskExecution.control(task.taskId, { commandId: 'start', revision: task.revision, action: 'start' });
    await adapter.waitForPromptCompletionBarrierEntry();
    const original = app.tasks.detail(task.taskId).runs![0]!;
    const pause = app.taskExecution.control(task.taskId, { commandId: 'pause', revision: app.tasks.get(task.taskId).revision, action: 'pause' });
    adapter.releasePromptCompletionBarrier(); await pause;
    await app.close();
    adapter = new FakeCoordinatorAdapter();
    app = createMultivacApplication(env, { coordinatorAdapter: adapter }); await app.ready;
    assert.deepEqual(app.tasks.detail(task.taskId).runs![0]!.inputSnapshot, original.inputSnapshot);
    const { readdir, writeFile } = await import('node:fs/promises');
    const directory = join(root, 'data/task-inputs'); const [key] = await readdir(directory);
    await writeFile(join(directory, key!), 'tampered');
    await app.taskExecution.control(task.taskId, { commandId: 'resume-corrupt', revision: app.tasks.get(task.taskId).revision, action: 'resume' });
    await app.taskExecution.idle();
    assert.equal(app.tasks.get(task.taskId).status, 'failed');
    assert.match(app.tasks.get(task.taskId).reason, /摘要不符|损坏/);
    assert.equal(adapter.calls.filter(call => call.method === 'prompt').length, 0);
    await rm(join(directory, key!));
    await assert.rejects(app.taskAttachments.readHistory(task.taskId, original.runId, input.id), /缺失/);
  } finally { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
