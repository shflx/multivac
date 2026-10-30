import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NoteSecurityService, NOTE_IDLE_TIMEOUT_MS } from '../src/application/note-security-service.js';
import { encryptNoteBytes, decryptNoteBytes, type NoteCiphertext } from '../src/modules/notes/note-crypto.js';
import { createNoteSecurityRequestHandler } from '../src/adapters/http/note-security-routes.js';

const window = 'a'.repeat(43);
const context = { noteId: 'one', kind: 'body', identity: 'revision:2' };

test('认证加密拒绝篡改、调换笔记、记录类型与版本，重复加密使用不同 nonce', () => {
  const key = randomBytes(32);
  const value = encryptNoteBytes(key, Buffer.from('私密正文'), context);
  assert.equal(decryptNoteBytes(key, value, context).toString(), '私密正文');
  assert.notEqual(value.nonce, encryptNoteBytes(key, Buffer.from('私密正文'), context).nonce);
  for (const changed of [{ ...context, noteId: 'two' }, { ...context, kind: 'title' }, { ...context, identity: 'revision:1' }]) assert.throws(() => decryptNoteBytes(key, value, changed));
  for (const changed of [{ ...value, ciphertext: Buffer.from('篡改').toString('base64') }, { ...value, format: 2 } as unknown as NoteCiphertext, { ...value, nonce: 'invalid' }, { ...value, tag: '' }]) assert.throws(() => decryptNoteBytes(key, changed, context));
  key.fill(0);
});

test('共用密码保护逐篇密钥，窗口和笔记资格独立，后台读取不延长无操作期限', async () => {
  const store = new SqliteAssistantStore(':memory:'); let now = 1000;
  const security = new NoteSecurityService(store.noteSecurity, () => now);
  try {
    await security.initialize('原共用密码');
    const one = { ...(await security.unlock('one', '原共用密码', window)), window };
    security.createDataKey('one', one);
    const data = security.withDataKey('one', one, key => encryptNoteBytes(key, Buffer.from('秘密'), context));
    assert.equal(security.withDataKey('one', one, key => decryptNoteBytes(key, data, context).toString()), '秘密');
    assert.throws(() => security.assertAccess('one'));
    assert.throws(() => security.assertAccess('two', one));
    assert.throws(() => security.assertAccess('one', { ...one, window: 'b'.repeat(43) }));
    await assert.rejects(() => security.unlock('one', '错误密码', window));
    now += NOTE_IDLE_TIMEOUT_MS - 1;
    security.assertAccess('one', one);
    now++;
    assert.throws(() => security.assertAccess('one', one));
    const next = { ...(await security.unlock('one', '原共用密码', window)), window };
    now += 1000; security.touch('one', next);
    now += NOTE_IDLE_TIMEOUT_MS - 1; security.assertAccess('one', next);
    security.lock('one', next); assert.throws(() => security.assertAccess('one', next));
  } finally { security.close(); store.close(); }
});

test('加密新笔记只用公钥、不需要密码，数据凭证只限这一篇，密码解锁可打开同一密钥', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const security = new NoteSecurityService(store.noteSecurity);
  try {
    assert.throws(() => security.beginEncryption('one', window), /请先设置/u);
    await security.initialize('共用密码');
    const one = security.beginEncryption('one', window);
    // 封装记录在转换事务内写入前，数据凭证不可用于读取。
    assert.throws(() => security.withDataKey('one', one, () => null), /密钥不存在/u);
    security.createDataKey('one', one);
    const data = security.withDataKey('one', one, key => encryptNoteBytes(key, Buffer.from('秘密'), context));
    // 已有密钥的笔记不能再免密码签发；数据凭证不能访问其他笔记或在其他窗口使用。
    assert.throws(() => security.beginEncryption('one', window), /请输入笔记密码/u);
    assert.throws(() => security.assertAccess('two', one));
    assert.throws(() => security.assertAccess('one', { ...one, window: 'b'.repeat(43) }));
    // 输入密码解锁后，用私钥打开同一把逐篇密钥。
    const unlocked = { ...(await security.unlock('one', '共用密码', 'b'.repeat(43))), window: 'b'.repeat(43) };
    assert.equal(security.withDataKey('one', unlocked, key => decryptNoteBytes(key, data, context).toString()), '秘密');
    // 封装记录被替换后，旧数据凭证不再沿用旧密钥。
    store.noteSecurity.database.prepare('DELETE FROM app_note_key WHERE note_id=?').run('one');
    const replacement = security.beginEncryption('one', 'c'.repeat(43)); security.createDataKey('one', replacement);
    assert.throws(() => security.withDataKey('one', one, () => null), /密钥已变化/u);
    const record = JSON.stringify([store.noteSecurity.password(), store.noteSecurity.key('one')]);
    assert.ok(!record.includes('共用密码'));
  } finally { security.close(); store.close(); }
});

test('密码变更只重新保护私钥并撤销凭证，公钥与逐篇密钥不变，重建服务不继承授权', async () => {
  const store = new SqliteAssistantStore(':memory:');
  let security = new NoteSecurityService(store.noteSecurity);
  try {
    await security.initialize('原密码');
    const one = { ...(await security.unlock('one', '原密码', window)), window };
    const two = { ...(await security.unlock('two', '原密码', window)), window };
    security.createDataKey('one', one); security.createDataKey('two', two);
    const wrapped = [store.noteSecurity.key('one'), store.noteSecurity.key('two')];
    const data = security.withDataKey('one', one, key => encryptNoteBytes(key, Buffer.from('秘密'), context));
    const publicKey = store.noteSecurity.password()!.publicKey;
    await security.changePassword('原密码', '新密码');
    assert.equal(store.noteSecurity.password()!.publicKey, publicKey);
    assert.throws(() => security.assertAccess('one', one)); assert.throws(() => security.assertAccess('two', two));
    assert.deepEqual([store.noteSecurity.key('one'), store.noteSecurity.key('two')], wrapped);
    await assert.rejects(() => security.unlock('one', '原密码', window));
    const current = { ...(await security.unlock('one', '新密码', window)), window };
    assert.equal(security.withDataKey('one', current, key => decryptNoteBytes(key, data, context).toString()), '秘密');
    security.close(); security = new NoteSecurityService(store.noteSecurity);
    assert.throws(() => security.assertAccess('one', current));
    const records = JSON.stringify(store.noteSecurity.password());
    assert.ok(!records.includes('原密码') && !records.includes('新密码'));
  } finally { security.close(); store.close(); }
});

test('密码记录提交失败保留原密码与旧凭证，损坏派生参数、版本和替换公钥被拒绝', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const security = new NoteSecurityService(store.noteSecurity);
  try {
    await security.initialize('原密码');
    const access = { ...(await security.unlock('one', '原密码', window)), window };
    store.noteSecurity.database.exec("CREATE TRIGGER fail_password BEFORE UPDATE ON app_note_password BEGIN SELECT RAISE(ABORT,'fault'); END;");
    await assert.rejects(() => security.changePassword('原密码', '新密码'), /fault/u);
    security.assertAccess('one', access);
    assert.equal(store.noteSecurity.password()!.revision, 1);
    await assert.rejects(() => security.unlock('one', '新密码', window));
    store.noteSecurity.database.exec('DROP TRIGGER fail_password');
    const current = store.noteSecurity.password()!;
    const other = new NoteSecurityService(new SqliteAssistantStore(':memory:').noteSecurity);
    await other.initialize('其他密码');
    const foreignKey = other.repository.password()!.publicKey; other.close();
    for (const modified of [{ ...current, format: 1 }, { ...current, kdf: { ...current.kdf, N: 1_000_000_000 } }, { ...current, publicKey: foreignKey }]) {
      store.noteSecurity.database.prepare('UPDATE app_note_password SET record_json=?').run(JSON.stringify(modified));
      await assert.rejects(() => security.unlock('one', '原密码', window));
    }
  } finally { security.close(); store.close(); }
});

test('密码 HTTP 契约不返回密钥，凭证不得通过 URL 或其他窗口替代', async () => {
  const store = new SqliteAssistantStore(':memory:'); const security = new NoteSecurityService(store.noteSecurity);
  const handler = createNoteSecurityRequestHandler(security);
  const server = createServer((request, response) => { void handler(request, response).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'content-type': 'application/json', 'x-note-window': window };
  try {
    assert.equal((await fetch(`${url}/api/note-security/password`, { method: 'POST', headers, body: JSON.stringify({ password: '密码' }) })).status, 200);
    const unlocked = await fetch(`${url}/api/notes/one/unlock`, { method: 'POST', headers, body: JSON.stringify({ password: '密码' }) });
    const value = await unlocked.json() as { token: string; idleTimeoutMs: number };
    assert.deepEqual(Object.keys(value).sort(), ['idleTimeoutMs', 'token']);
    assert.equal((await fetch(`${url}/api/notes/one/access?token=${value.token}`, { headers })).status, 423);
    assert.equal((await fetch(`${url}/api/notes/one/access`, { headers: { ...headers, 'x-note-access': value.token } })).status, 200);
    assert.equal((await fetch(`${url}/api/notes/two/access`, { headers: { ...headers, 'x-note-access': value.token } })).status, 423);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); security.close(); store.close(); }
});
