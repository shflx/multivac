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
    assert.equal((await app.taskAttachments.readFixed(first)).toString(), '{"answer":42}');
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
