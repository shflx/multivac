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
