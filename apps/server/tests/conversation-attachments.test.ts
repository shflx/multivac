import { remoteRouteAllowed } from '../src/adapters/http/remote-policy.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GLOBAL_ASSISTANT_SESSION_ID as sessionId } from '@multivac/contracts';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { FakeCoordinatorAdapter } from '../src/runtime/executors/fake-coordinator-adapter.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'multivac-conversation-files-'));
  const adapter = new FakeCoordinatorAdapter();
  const app = createMultivacApplication(testApplicationEnvironment(root), { coordinatorAdapter: adapter });
  await app.ready;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: response.status, value: await response.json() as any };
  };
  return { app, adapter, request, async close() { adapter.releasePromptCompletionBarrier(); await app.taskExecution.idle(); await app.close(); await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); } };
}

test('会话草稿随消息发送并持久展示；命令重试幂等、不同命令及跨会话拒绝', async () => {
  const f = await fixture();
  try {
    const draftId = randomUUID(), id = randomUUID();
    const owner = { draftId, sessionId };
    await f.app.taskAttachments.upload(owner, id, '需求.md', Buffer.from('# 需求\n核对码=7391'));
    assert.throws(() => f.app.taskAttachments.messageDraft('other-session', draftId), /不属于/);
    assert.throws(() => f.app.taskAttachments.messageDraft(sessionId, randomUUID()), /不属于|不存在/);
    const command = { commandId: randomUUID(), assistantSessionId: sessionId, text: '读取需求', contextRefs: [], attachmentDraftId: draftId };
    const sent = await f.request('/api/assistant/turns', command);
    assert.equal(sent.status, 200, JSON.stringify(sent.value));
    const replay = await f.request('/api/assistant/turns', command);
    assert.equal(replay.status, 200);
    const conflict = await f.request('/api/assistant/turns', { ...command, attachmentDraftId: randomUUID() });
    assert.equal(conflict.status, 409);
    const reuse = await f.request('/api/assistant/turns', { ...command, commandId: randomUUID() });
    assert.ok(reuse.status >= 400);
    await assert.rejects(f.app.taskAttachments.upload(owner, randomUUID(), 'late.txt', Buffer.from('late')), /已随消息发送/);
    assert.throws(() => f.app.taskAttachments.remove(owner, id), /已随消息发送/);
    const page = await f.request('/api/assistant/session');
    const user = page.value.messages.find((item: any) => item.attachments?.draftId === draftId);
    assert.equal(user.attachments.attachments[0].name, '需求.md');
    assert.equal(user.attachments.attachments[0].bytes, Buffer.byteLength('# 需求\n核对码=7391'));
    const prompt = f.adapter.calls.findLast(call => call.method === 'prompt');
    assert.equal(prompt?.method === 'prompt' ? prompt.context?.attachments?.draftId : null, draftId);
  } finally { await f.close(); }
});

test('请求正文未接收完成时拒绝发送，失败释放上传占用', async () => {
  const f = await fixture();
  try {
    const owner = { draftId: randomUUID(), sessionId };
    let finish!: (data: Buffer) => void;
    const receiving = f.app.taskAttachments.receive(owner, randomUUID(), 'slow.md', () => new Promise(resolve => { finish = resolve; }));
    assert.throws(() => f.app.taskAttachments.messageDraft(sessionId, owner.draftId), /仍在上传/);
    finish(Buffer.from('完整内容')); await receiving;
    await assert.rejects(f.app.taskAttachments.receive(owner, randomUUID(), 'failed.md', async () => { throw new Error('断开'); }), /断开/);
    assert.equal(f.app.taskAttachments.messageDraft(sessionId, owner.draftId).attachments.length, 1);
  } finally { await f.close(); }
});


test('全局工具读取真实草稿并一次性领用；未发送、跨会话、重复领用和确认竞争均拒绝', async () => {
  const f = await fixture();
  try {
    await f.request('/api/assistant/session');
    const call = f.adapter.calls.find(call => (call.method === 'createSession' || call.method === 'continueRecentSession') && call.input.assistantSessionId === sessionId);
    assert.ok(call?.method === 'createSession' || call?.method === 'continueRecentSession');
    const tools = call.input.internalTools!;
    const invoke = (name: string, args: unknown, toolCallId = randomUUID()) => tools.invoke({ assistantSessionId: sessionId, toolName: name, toolCallId, args }, new AbortController().signal);
    const draftId = randomUUID(), id = randomUUID(), text = '# 需求\n上传原文=7391';
    await f.app.taskAttachments.upload({ draftId, sessionId }, id, '需求.md', Buffer.from(text));
    const input = { title: '附带需求', goal: '读取上传原件', attachmentDraftId: draftId };
    assert.equal((await invoke('create_task', input)).ok, false);
    assert.equal((await invoke('create_task', { ...input, attachmentDraftId: randomUUID() })).ok, false);
    const dialogDraftId = randomUUID();
    await f.app.taskAttachments.upload({ draftId: dialogDraftId }, randomUUID(), 'dialog.txt', Buffer.from('任务表单草稿不可被模型领用'));
    assert.equal((await invoke('create_task', { ...input, attachmentDraftId: dialogDraftId })).ok, false);
    assert.equal((await invoke('list_task_attachments', { attachmentDraftId: draftId })).ok, false);
    const foreign = randomUUID();
    await f.app.taskAttachments.upload({ draftId: foreign, sessionId: 'other-session' }, randomUUID(), 'other.md', Buffer.from('别的会话'));
    assert.equal((await invoke('create_task', { ...input, attachmentDraftId: foreign })).ok, false);
    await f.request('/api/assistant/turns', { commandId: randomUUID(), assistantSessionId: sessionId, text: '请创建任务', contextRefs: [], attachmentDraftId: draftId });
    const list = await invoke('list_task_attachments', { attachmentDraftId: draftId });
    assert.ok(list.ok); assert.equal(JSON.parse(list.content).attachments[0].id, id);
    const read = await invoke('read_task_attachment', { attachmentDraftId: draftId, attachmentId: id });
    assert.ok(read.ok); assert.equal(JSON.parse(read.content).text, text);
    const proposed = await invoke('propose_create_task', input);
    assert.ok(proposed.ok, proposed.content);
    const cards = (await f.request('/api/assistant/proposals')).value.proposals;
    const card = cards.find((item: any) => item.payload.attachmentDraftId === draftId);
    assert.equal(card.preview.attachments[0].name, '需求.md');
    assert.throws(() => f.app.tasks.create({ commandId: randomUUID(), ...input }), /只能由所属会话/);
    const invocationId = randomUUID();
    const created = await invoke('create_task', input, invocationId);
    assert.ok(created.ok, created.content);
    assert.equal((await invoke('create_task', input, invocationId)).content, created.content);
    const task = f.app.tasks.list().tasks[0]!;
    assert.equal((await f.app.taskAttachments.read({ taskId: task.taskId }, id)).data.toString(), text);
    assert.equal((await invoke('create_task', input)).ok, false);
    assert.equal((await invoke('read_task_attachment', { attachmentDraftId: draftId, attachmentId: id })).ok, false);
    const taskRead = await invoke('read_task_attachment', { taskId: task.taskId, attachmentId: id });
    assert.ok(taskRead.ok); assert.equal(JSON.parse(taskRead.content).text, text);
    const confirmed = await f.request(`/api/assistant/proposals/${card.proposalId}/decision`, { decision: 'confirm', options: { agentId: 'general' } });
    assert.equal(confirmed.value.proposal.status, 'expired', JSON.stringify(confirmed));
    assert.equal(f.app.tasks.list().total, 1);
    const page = (await f.request('/api/assistant/session')).value;
    assert.equal(page.messages.find((item: any) => item.attachments?.draftId === draftId).attachments.taskId, task.taskId);
    assert.equal((await f.app.taskAttachments.readMessageAttachment(sessionId, draftId, id)).data.toString(), text);
  } finally { await f.close(); }
});


test('远程附件路径只开放全局会话，不开放任务、其他会话或伪造内容路径', () => {
  const base = `/api/sessions/${sessionId}/attachment-drafts/${randomUUID()}/attachments`;
  const id = randomUUID();
  assert.equal(remoteRouteAllowed('PUT', `${base}/${id}`), true);
  assert.equal(remoteRouteAllowed('GET', `${base}/${id}/content`), true);
  assert.equal(remoteRouteAllowed('DELETE', `${base}/${id}`), true);
  assert.equal(remoteRouteAllowed('POST', base), false);
  assert.equal(remoteRouteAllowed('GET', `${base}/${id}/content/extra`), false);
  assert.equal(remoteRouteAllowed('GET', base.replace(sessionId, 'other-session')), false);
  assert.equal(remoteRouteAllowed('GET', `/api/tasks/${randomUUID()}/attachments`), false);
});

test('七天清理删除未领用原件和记录，保留新草稿、已领用附件及消息名称大小，过期身份不能复活', async () => {
  const f = await fixture();
  const { DatabaseSync } = await import('node:sqlite');
  const { access } = await import('node:fs/promises');
  try {
    const expired = randomUUID(), recent = randomUUID(), claimed = randomUUID();
    const expiredFile = await f.app.taskAttachments.upload({ draftId: expired, sessionId }, randomUUID(), '需求.md', Buffer.from('过期材料'));
    await f.app.taskAttachments.upload({ draftId: recent, sessionId }, randomUUID(), '新材料.md', Buffer.from('仍保留'));
    const claimedFile = await f.app.taskAttachments.upload({ draftId: claimed, sessionId }, randomUUID(), '已领用.md', Buffer.from('永久任务输入'));
    for (const draftId of [expired, claimed]) await f.request('/api/assistant/turns', { commandId: randomUUID(), assistantSessionId: sessionId, text: '保留文件', contextRefs: [], attachmentDraftId: draftId });
    const task = f.app.tasks.create({ commandId: randomUUID(), attachmentDraftId: claimed, title: '保留已领用', goal: '核对' }, undefined, sessionId).task;
    const before = (await f.request('/api/assistant/session')).value.messages.find((item: any) => item.attachments?.draftId === expired).attachments;
    const key = f.app.taskAttachments.repository.storageKey(expiredFile.id)!;
    const database = new DatabaseSync(f.app.paths.databasePath);
    const age = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
    database.prepare('UPDATE session_attachment_draft SET created_at=? WHERE id IN (?,?)').run(age(8), expired, claimed);
    database.prepare('UPDATE session_attachment_draft SET created_at=? WHERE id=?').run(age(6), recent);
    database.close();
    assert.equal(await f.app.taskAttachments.cleanupExpired(), 1);
    assert.equal(await f.app.taskAttachments.cleanupExpired(), 0);
    assert.equal(f.app.taskAttachments.repository.sessionDraft(expired), undefined);
    assert.equal(f.app.taskAttachments.repository.get(expiredFile.id), undefined);
    await assert.rejects(access(join(f.app.paths.dataDir, 'task-inputs', key)), /ENOENT/);
    assert.equal(f.app.taskAttachments.list({ draftId: recent, sessionId }).length, 1);
    assert.equal((await f.app.taskAttachments.read({ taskId: task.taskId }, claimedFile.id)).data.toString(), '永久任务输入');
    const after = (await f.request('/api/assistant/session')).value.messages.find((item: any) => item.attachments?.draftId === expired).attachments;
    assert.equal(after.expired, true);
    assert.deepEqual(after.attachments, before.attachments);
    await assert.rejects(f.app.taskAttachments.readMessageAttachment(sessionId, expired, expiredFile.id), /过期/);
    await assert.rejects(f.app.taskAttachments.upload({ draftId: expired, sessionId }, randomUUID(), '复活.md', Buffer.from('禁止复活')), /身份已使用/);
    assert.throws(() => f.app.tasks.create({ commandId: randomUUID(), attachmentDraftId: expired, title: '过期', goal: '拒绝' }, undefined, sessionId), /已随本会话/);
  } finally { await f.close(); }
});

test('清理跳过上传中的草稿，正文结束后清理可重放', async () => {
  const f = await fixture();
  try {
    const owner = { draftId: randomUUID(), sessionId };
    let finish!: (data: Buffer) => void;
    const receiving = f.app.taskAttachments.receive(owner, randomUUID(), 'slow.md', () => new Promise(resolve => { finish = resolve; }));
    const future = new Date(Date.now() + 8 * 86400000);
    assert.equal(await f.app.taskAttachments.cleanupExpired(future), 0);
    finish(Buffer.from('完整文件')); await receiving;
    assert.equal(await f.app.taskAttachments.cleanupExpired(future), 1);
    assert.equal(await f.app.taskAttachments.cleanupExpired(future), 0);
  } finally { await f.close(); }
});

test('消息受理持久化失败时草稿锁定回滚，原命令可再次受理', async () => {
  const f = await fixture();
  const { DatabaseSync } = await import('node:sqlite');
  try {
    const draftId = randomUUID();
    await f.app.taskAttachments.upload({ draftId, sessionId }, randomUUID(), '需求.md', Buffer.from('事务回滚'));
    const command = { commandId: randomUUID(), assistantSessionId: sessionId, text: '创建任务', contextRefs: [], attachmentDraftId: draftId };
    const database = new DatabaseSync(f.app.paths.databasePath);
    try {
      database.exec("CREATE TRIGGER reject_attachment_message BEFORE INSERT ON assistant_command_receipt BEGIN SELECT RAISE(ABORT, '受理失败'); END");
      const failed = await f.request('/api/assistant/turns', command);
      assert.equal(failed.status, 500);
      assert.equal(f.app.taskAttachments.repository.sessionDraft(draftId)!.commandId, null);
    } finally {
      database.exec('DROP TRIGGER IF EXISTS reject_attachment_message');
      database.close();
    }
    const sent = await f.request('/api/assistant/turns', command);
    assert.equal(sent.status, 200);
    assert.equal(f.app.taskAttachments.repository.sessionDraft(draftId)!.commandId, command.commandId);
  } finally { await f.close(); }
});
