import test from 'node:test';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { openEventStream } from './fixtures/sse-client.js';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMultivacApplication } from '../src/bootstrap/application.js';
import { testApplicationEnvironment } from './fixtures/test-environment.js';

async function fixture() {
  await mkdir(resolve('.tmp'), { recursive: true }); const root = await mkdtemp(resolve('.tmp/note-encryption-http-'));
  let app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' }); let base = '';
  async function start() { await app.ready; await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; }
  async function stop() { app.server.closeAllConnections(); await new Promise<void>(resolve => app.server.close(() => resolve())); await app.close(); }
  await start();
  const window = 'a'.repeat(43);
  async function request(path: string, method = 'GET', body?: unknown, token?: string) {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-note-window': window, ...(token ? { 'x-note-access': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  return { request, root, window, get base() { return base; }, async restart() { await stop(); app = createMultivacApplication({ ...testApplicationEnvironment(root), MULTIVAC_E2E_CONTROL: '1' }); await start(); }, async close() { await stop(); await rm(root, { recursive: true, force: true }); } };
}

test('应用级接口逐篇授权，密钥在另一窗口可用不绕过正文、历史、图片、建议及通用讨论入口', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two']) assert.equal((await f.request('/api/notes', 'POST', { id, commandId: id, title: `标题哨兵${id}`, body: `正文哨兵${id}` })).status, 200);
    assert.equal((await f.request('/api/note-security/password', 'POST', { password: '共用密码' })).status, 200);
    const root = await f.request('/api/notes/one/companion', 'POST'); assert.equal(root.status, 200); const sessionId = root.body.sessionId;
    assert.equal((await f.request(`/api/sessions/${sessionId}/session`)).status, 200);
    const token = (await f.request('/api/notes/one/unlock', 'POST', { password: '共用密码' })).body.token as string;
    const encrypted = await f.request('/api/notes/one/protection', 'POST', { action: 'encrypt', expectedRevision: 1 }, token);
    assert.equal(encrypted.status, 200, JSON.stringify(encrypted)); assert.equal(encrypted.body.state, 'encrypted');
    for (const path of ['/api/notes/one', '/api/notes/one/versions', '/api/notes/one/versions/1', '/api/notes/one/discussions', '/api/notes/one/suggestions', `/api/notes/one/images/${'a'.repeat(64)}/content`, `/api/sessions/${sessionId}/session`, `/api/sessions/${sessionId}/page-state`, `/api/sessions/${sessionId}/events?after=0&until=99999`]) {
      const result = await f.request(path); assert.equal(result.status, 423, `${path}: ${JSON.stringify(result)}`); assert.ok(!JSON.stringify(result).includes('哨兵'));
    }
    assert.equal((await f.request('/api/notes/one', 'GET', undefined, token)).body.body, '正文哨兵one');
    const list = await f.request('/api/notes'); assert.equal(list.status, 200); assert.ok(!JSON.stringify(list.body).includes('标题哨兵one')); assert.ok(JSON.stringify(list.body).includes('标题哨兵two'));
    const wrongWindow = await fetch(`${f.base}/api/notes/one`, { headers: { 'x-note-access': token, 'x-note-window': 'b'.repeat(43) } }); assert.equal(wrongWindow.status, 423);
    assert.equal((await f.request('/api/notes/one/lock', 'POST', undefined, token)).status, 200);
    assert.equal((await f.request('/api/notes/one', 'GET', undefined, token)).status, 423);
    assert.equal((await f.request('/api/notes/two')).body.body, '正文哨兵two');
    const token2 = (await f.request('/api/notes/one/unlock', 'POST', { password: '共用密码' })).body.token;
    await f.restart();
    assert.equal((await f.request('/api/notes/one', 'GET', undefined, token2)).status, 423);
    const fresh = (await f.request('/api/notes/one/unlock', 'POST', { password: '共用密码' })).body.token;
    assert.equal((await f.request('/api/notes/one', 'GET', undefined, fresh)).body.body, '正文哨兵one');
    assert.equal((await f.request('/api/notes/one/protection', 'POST', { action: 'decrypt', expectedRevision: 1 }, fresh)).status, 200);
    assert.equal((await f.request('/api/notes/one')).body.body, '正文哨兵one');
  } finally { await f.close(); }
});

test('解锁后的显式讨论继续密文落库，Agent 工具不能继承窗口凭证', async () => {
  const f = await fixture();
  try {
    await f.request('/api/notes', 'POST', { id: 'one', commandId: 'one', title: '标题哨兵', body: '正文哨兵' });
    await f.request('/api/note-security/password', 'POST', { password: '密码' });
    const token = (await f.request('/api/notes/one/unlock', 'POST', { password: '密码' })).body.token;
    await f.request('/api/notes/one/protection', 'POST', { action: 'encrypt', expectedRevision: 1 }, token);
    const discussion = await f.request('/api/notes/one/companion', 'POST', undefined, token); assert.equal(discussion.status, 200, JSON.stringify(discussion)); const id = discussion.body.sessionId;
    const context = await f.request('/api/notes/one/contexts', 'POST', { commandId: 'context', id: 'context', sessionId: id, revision: 1, selection: null }, token); assert.equal(context.status, 200);
    const send = await f.request(`/api/sessions/${id}/turns`, 'POST', { commandId: 'send', assistantSessionId: id, text: '讨论输入哨兵', contextRefs: [{ kind: 'note', snapshotId: 'context' }] }, token);
    assert.equal(send.status, 200, JSON.stringify(send));
    assert.equal(send.body.terminalOutcome, 'succeeded', JSON.stringify(send));
    const bytes = await readFile(join(f.root, 'data', 'multivac.sqlite')); assert.ok(!bytes.includes(Buffer.from('讨论输入哨兵')));
    const global = await f.request('/api/assistant/turns', 'POST', { commandId: 'global', assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, text: '内部工具：read_note {"noteId":"one"}', contextRefs: [] }, token);
    assert.equal(global.status, 200, JSON.stringify(global));
    const page = await f.request('/api/assistant/session');
    assert.ok(!JSON.stringify(page).includes('正文哨兵'));
    assert.ok(JSON.stringify(page).includes('read_note'), JSON.stringify(page));
    const lockedStream = openEventStream(Number(new URL(f.base).port), '/api/events?after=0');
    const unlockedStream = openEventStream(Number(new URL(f.base).port), '/api/events?after=0', { 'x-note-window': f.window, 'x-note-grants': JSON.stringify({ one: token }) });
    try {
      assert.equal((await lockedStream.response).status, 200); assert.equal((await unlockedStream.response).status, 200);
      await unlockedStream.waitFor(messages => messages.some(message => message.data.assistantSessionId === id));
      assert.ok(!lockedStream.messages.some(message => message.data.assistantSessionId === id));
      const second = await f.request(`/api/sessions/${id}/turns`, 'POST', { commandId: 'send-second', assistantSessionId: id, text: '第二轮讨论', contextRefs: [{ kind: 'note', snapshotId: 'context' }] }, token); assert.equal(second.status, 200, JSON.stringify(second));
      await unlockedStream.waitFor(messages => messages.some(message => message.data.commandId === 'send-second'));
      assert.ok(!lockedStream.messages.some(message => message.data.assistantSessionId === id));
      await f.request('/api/__e2e/assistant/prompt-completion/arm-streaming', 'POST', {});
      const late = f.request(`/api/sessions/${id}/turns`, 'POST', { commandId: 'send-late', assistantSessionId: id, text: '锁定中讨论', contextRefs: [{ kind: 'note', snapshotId: 'context' }] }, token);
      await f.request('/api/__e2e/assistant/prompt-completion/entered');
      await f.request('/api/notes/one/lock', 'POST', undefined, token); await unlockedStream.waitForEnd();
      await f.request('/api/__e2e/assistant/prompt-completion/release', 'POST', {});
      assert.equal((await late).status, 423);
      assert.ok(!JSON.stringify(lockedStream.messages).includes('锁定中讨论'));
      assert.equal((await f.request(`/api/sessions/${id}/session`, 'GET', undefined, token)).status, 423);
    } finally { lockedStream.close(); unlockedStream.close(); }
  } finally { await f.close(); }
});

test('浏览器草稿密文绑定笔记与包身份，更换密码后仍可恢复；锁定后拒绝读取', async () => {
  const f = await fixture();
  try {
    for (const id of ['one', 'two']) await f.request('/api/notes', 'POST', { id, commandId: id, title: id, body: '' });
    await f.request('/api/note-security/password', 'POST', { password: '原密码' });
    let token = (await f.request('/api/notes/one/unlock', 'POST', { password: '原密码' })).body.token;
    await f.request('/api/notes/one/protection', 'POST', { action: 'encrypt', expectedRevision: 1 }, token);
    const content = JSON.stringify({ draft: '未保存正文哨兵', pending: { commandId: '稳定命令' } });
    const sealed = await f.request('/api/notes/one/vault', 'POST', { action: 'seal', id: 'window-draft', content }, token);
    assert.equal(sealed.status, 200); assert.ok(!JSON.stringify(sealed.body).includes('哨兵'));
    const open = (cipher: unknown, id = 'window-draft', note = 'one') => f.request(`/api/notes/${note}/vault`, 'POST', { action: 'open', id, content: cipher }, token);
    assert.equal((await open(sealed.body.content)).body.content, content);
    assert.equal((await open(sealed.body.content, 'other-draft')).status, 403);
    assert.equal((await open(sealed.body.content, 'window-draft', 'two')).status, 423);
    assert.equal((await open({ ...sealed.body.content, tag: 'AAAAAAAAAAAAAAAAAAAAAA==' })).status, 403);
    assert.equal((await f.request('/api/notes/one/vault', 'POST', { action: 'open', id: 'window-draft', content: sealed.body.content })).status, 423);
    assert.equal((await f.request('/api/note-security/password', 'PUT', { currentPassword: '原密码', password: '新密码' })).status, 200);
    assert.equal((await open(sealed.body.content)).status, 423);
    token = (await f.request('/api/notes/one/unlock', 'POST', { password: '新密码' })).body.token;
    assert.equal((await open(sealed.body.content)).body.content, content);
  } finally { await f.close(); }
});

test('删除加密笔记保留无正文墓碑，不破坏讨论密文，也不重放原内容', async () => {
  const f = await fixture();
  try {
    await f.request('/api/notes', 'POST', { id: 'deleted', commandId: 'created', title: '删除标题哨兵', body: '删除正文哨兵' });
    const discussion = await f.request('/api/notes/deleted/companion', 'POST');
    await f.request('/api/note-security/password', 'POST', { password: '密码' });
    const token = (await f.request('/api/notes/deleted/unlock', 'POST', { password: '密码' })).body.token;
    assert.equal((await f.request('/api/notes/deleted/protection', 'POST', { action: 'encrypt', expectedRevision: 1 }, token)).status, 200);
    const removed = await f.request('/api/notes/deleted', 'DELETE', { commandId: 'delete', expectedRevision: 1 }, token);
    assert.equal(removed.status, 200, JSON.stringify(removed));
    for (const [path, method, body] of [['/api/notes/deleted', 'GET'], ['/api/notes/deleted/unlock', 'POST', { password: '密码' }], ['/api/notes/deleted/vault', 'POST', { action: 'seal', id: 'draft', content: '正文' }], [`/api/sessions/${discussion.body.sessionId}/session`, 'GET']] as const) {
      assert.equal((await f.request(path, method, body, token)).status, 404, path);
    }
    const replay = await f.request('/api/notes/deleted', 'DELETE', { commandId: 'delete', expectedRevision: 1 }, token);
    assert.equal(replay.status, 200, JSON.stringify(replay)); assert.deepEqual(replay.body, { id: 'deleted', deleted: true });
    assert.deepEqual((await f.request('/api/notes')).body.notes, []);
  } finally { await f.close(); }
});
