import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteAssistantService } from '../src/application/note-assistant-service.js';
import { NoteSecurityService } from '../src/application/note-security-service.js';
import { SqliteNoteEncryption } from '../src/storage/sqlite-note-encryption.js';
import { SqliteProtectedTranscripts } from '../src/storage/sqlite-protected-transcripts.js';
import { protectedPiSession } from '../src/runtime/executors/pi-protected-session.js';
import { noteDiscussions, noteSources } from './fixtures/note-discussions.js';

async function fixture(fault?: (stage: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'multivac-encrypted-notes-'));
  const root = join(dir, 'sessions'); mkdirSync(root);
  const store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const security = new NoteSecurityService(store.noteSecurity); store.noteCodec.bind(security);
  const notes = new NotesService(store.notes, noteDiscussions());
  const assistant = new NoteAssistantService(store.noteAssistant, notes, root, noteSources());
  const encryption = new SqliteNoteEncryption(store.noteCodec, security, notes, noteDiscussions(), root, fault);
  notes.create({ commandId: 'create', id: 'one', title: '私密标题哨兵', body: '私密正文哨兵' });
  notes.update('one', { commandId: 'update', expectedRevision: 1, body: '第二版私密正文哨兵' });
  notes.create({ commandId: 'ordinary', id: 'other', title: '普通标题', body: '普通内容' });
  const discussion = assistant.ensureRoot('one');
  const snapshot = assistant.prepare('one', { commandId: 'context', id: 'snapshot', sessionId: discussion.sessionId, revision: 1, selection: { start: 0, end: 2, text: '私密' } });
  const imageBytes = Buffer.from('图片二进制哨兵');
  store.noteImages.insert({ id: 'image', noteId: 'one', mimeType: 'image/png', width: 1, height: 1, bytes: imageBytes.length, retained: false }, imageBytes);
  store.noteSuggestions.insertSource('source', [{ id: 'suggestion', noteId: 'one', sessionId: discussion.sessionId, snapshotId: snapshot.id, sourceRuntimeSessionId: 'runtime', sourceRuntimeEntryId: 'reply', appliedRevision: null, baseRevision: 2, reason: '私密建议哨兵', before: '第二版', after: '修改', start: 0, end: 3, status: 'pending', createdAt: '2026-01-01', decidedAt: null, problem: null }]);
  const imageRoot = join(dir, 'images'); mkdirSync(imageRoot);
  const discussionImagePath = join(imageRoot, 'a'.repeat(64));
  writeFileSync(discussionImagePath, '讨论图片哨兵');
  store.images.insert({ id: 'a'.repeat(64), sessionId: discussion.sessionId, mimeType: 'image/png', width: 1, height: 1, bytes: 18 });
  store.images.saveSources(discussion.sessionId, 'runtime', 'first', [{ href: 'source', imageId: 'a'.repeat(64) }]);
  const path = join(root, 'discussion.jsonl');
  const transcript = JSON.stringify({ type: 'session', version: 3, id: 'runtime', timestamp: '2026-01-01', cwd: root }) + '\n' + JSON.stringify({ type: 'message', id: 'first', parentId: null, timestamp: '2026-01-01', message: { role: 'user', content: '讨论消息哨兵', timestamp: 1 } }) + '\n';
  writeFileSync(path, transcript);
  store.bindings.insertIfAbsent({ assistantSessionId: discussion.sessionId, harness: 'pi', runtimeSessionId: 'runtime', runtimeSessionRef: path, updatedAt: '2026-01-01' });
  store.pageStates.save(discussion.sessionId, { draft: '讨论草稿哨兵', anchorEntryId: null, anchorOffsetPx: 0, quote: null, revision: 0 });
  store.events.append({ sourceKey: 'event', assistantSessionId: discussion.sessionId, commandId: null, type: 'assistant.message.delta', data: { runtimeSessionId: 'runtime', messageId: 'reply', delta: '讨论消息哨兵' }, occurredAt: '2026-01-01' });
  await security.initialize('共用密码');
  const access = { ...(await security.unlock('one', '共用密码', 'a'.repeat(43))), window: 'a'.repeat(43) };
  return { dir, store, security, notes, assistant, encryption, access, discussion, path, transcript, imageBytes, discussionImagePath,
    close() { security.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('逐篇转换覆盖历史、图片、摘要、回执、建议和讨论，编辑继续密文保存，取消加密完整恢复', async () => {
  const f = await fixture();
  try {
    const original = f.notes.get('one');
    f.encryption.encrypt('one', 2, f.access);
    assert.equal(f.encryption.status('one').state, 'encrypted'); assert.ok(!existsSync(f.path)); assert.ok(!existsSync(f.discussionImagePath));
    const raw = readFileSync(join(f.dir, 'db.sqlite'));
    for (const sentinel of ['私密标题哨兵', '私密正文哨兵', '图片二进制哨兵', '私密建议哨兵', '讨论草稿哨兵', '讨论消息哨兵', '讨论图片哨兵']) assert.ok(!raw.includes(Buffer.from(sentinel)), sentinel);
    assert.throws(() => f.notes.get('one')); assert.throws(() => f.store.noteImages.read('one', 'image'));
    assert.equal(f.notes.get('other').body, '普通内容');
    f.store.noteCodec.run(f.access, () => {
      assert.deepEqual(f.notes.get('one'), original);
      assert.equal(f.notes.get('one', 1).body, '私密正文哨兵');
      assert.deepEqual(f.store.noteImages.read('one', 'image').data, f.imageBytes);
      assert.equal(f.store.noteSuggestions.get('suggestion').reason, '私密建议哨兵');
      assert.equal(f.store.pageStates.get(f.discussion.sessionId).draft, '讨论草稿哨兵');
      assert.equal(f.store.events.streamingEvents(f.discussion.sessionId)[0]!.data.delta, '讨论消息哨兵');
      assert.equal(f.assistant.discussions('one')[0]!.title, '梳理 · 私密标题哨兵');
      assert.equal(f.notes.operation('create')!.body, '私密正文哨兵');
      assert.equal(new SqliteProtectedTranscripts(f.store.noteCodec).read(f.path), f.transcript);
      assert.equal(new SqliteProtectedTranscripts(f.store.noteCodec).readBytes(f.discussionImagePath).toString(), '讨论图片哨兵');
      assert.equal(f.store.images.get('a'.repeat(64))!.mimeType, 'image/png');
      f.notes.update('one', { commandId: 'encrypted-update', expectedRevision: 2, body: '已解锁编辑哨兵' });
      assert.equal(f.store.noteSuggestions.get('suggestion').status, 'stale');
    });
    f.encryption.decrypt('one', 3, f.access);
    assert.equal(f.encryption.status('one').state, 'plain');
    assert.equal(f.notes.get('one').body, '已解锁编辑哨兵');
    assert.equal(f.notes.get('one', 1).body, '私密正文哨兵');
    assert.equal(readFileSync(f.path, 'utf8'), f.transcript);
    assert.equal(readFileSync(f.discussionImagePath, 'utf8'), '讨论图片哨兵');
  } finally { f.close(); }
});

for (const stage of ['before-commit', 'after-commit', 'before-cleanup', 'after-cleanup']) test(`加密故障 ${stage} 保留唯一可读副本，重建服务后可恢复`, async () => {
  let fail = true;
  const f = await fixture(actual => { if (fail && actual === stage) { fail = false; throw new Error('injected fault'); } });
  try {
    assert.throws(() => f.encryption.encrypt('one', 2, f.access), /injected/u);
    if (stage === 'before-commit') {
      assert.equal(f.encryption.status('one').state, 'plain');
      assert.equal(f.notes.get('one').body, '第二版私密正文哨兵');
      assert.equal(readFileSync(f.path, 'utf8'), f.transcript);
      f.encryption.encrypt('one', 2, f.access);
    } else {
      assert.equal(f.encryption.status('one').state, 'encrypting');
      assert.throws(() => f.notes.get('one'));
      // 丢弃全部解锁状态，再按现有数据库与文件事实恢复。
      f.security.close(); const restarted = new NoteSecurityService(f.store.noteSecurity); f.store.noteCodec.bind(restarted);
      try {
        const access = { ...(await restarted.unlock('one', '共用密码', 'b'.repeat(43))), window: 'b'.repeat(43) };
        const service = new SqliteNoteEncryption(f.store.noteCodec, restarted, f.notes, noteDiscussions(), join(f.dir, 'sessions'));
        service.recover('one', access);
        f.store.noteCodec.run(access, () => assert.equal(f.notes.get('one').body, '第二版私密正文哨兵'));
      } finally { restarted.close(); }
    }
    assert.equal(f.encryption.status('one').state, 'encrypted'); assert.ok(!existsSync(f.path));
  } finally { f.close(); }
});

test('受保护 Pi 使用内存会话并直接保存密文，追加消息不会生成明文文件', async () => {
  const f = await fixture();
  try {
    f.encryption.encrypt('one', 2, f.access);
    f.store.noteCodec.run(f.access, () => {
      const transcripts = new SqliteProtectedTranscripts(f.store.noteCodec);
      const manager = protectedPiSession(transcripts, f.discussion.sessionId, f.path, join(f.dir, 'sessions'), true);
      manager.appendMessage({ role: 'user', content: '新增讨论哨兵', timestamp: 1 });
      assert.ok(transcripts.read(f.path).includes('新增讨论哨兵'));
      assert.ok(!existsSync(f.path));
      const restored = protectedPiSession(transcripts, f.discussion.sessionId, f.path, join(f.dir, 'sessions'), true);
      assert.equal(restored.getEntries().length, 2);
    });
  } finally { f.close(); }
});

for (const stage of ['after-commit', 'before-cleanup', 'restore-written', 'after-cleanup', 'before-commit']) test(`取消加密故障 ${stage} 可从密文恢复，未完成时不恢复普通访问`, async () => {
  const f = await fixture();
  try {
    f.encryption.encrypt('one', 2, f.access);
    let armed = true;
    const service = new SqliteNoteEncryption(f.store.noteCodec, f.security, f.notes, noteDiscussions(), join(f.dir, 'sessions'), actual => {
      if (armed && actual === stage) { armed = false; throw new Error('injected reverse fault'); }
    });
    assert.throws(() => service.decrypt('one', 2, f.access), /injected/u);
    assert.equal(service.status('one').state, 'decrypting');
    assert.throws(() => f.notes.get('one'));
    service.recover('one', f.access);
    assert.equal(service.status('one').state, 'plain');
    assert.equal(f.notes.get('one').body, '第二版私密正文哨兵');
    assert.equal(readFileSync(f.path, 'utf8'), f.transcript);
  } finally { f.close(); }
});

test('删除加密笔记清理旧正文回执并保持归档讨论密文有效', async () => {
  const f = await fixture();
  try {
    f.encryption.encrypt('one', 2, f.access);
    f.store.noteCodec.run(f.access, () => {
      const deletion = { commandId: 'delete-encrypted', expectedRevision: 2 };
      assert.deepEqual(f.notes.remove('one', deletion), { id: 'one', deleted: true });
      assert.deepEqual(f.notes.remove('one', deletion), { id: 'one', deleted: true });
      assert.throws(() => f.notes.operation('create'), /已删除/u);
      assert.throws(() => f.notes.operation('update'), /已删除/u);
      assert.throws(() => f.notes.get('one'), /已删除/u);
      const archived = f.store.noteAssistant.discussions('one')[0]!;
      assert.equal(archived.title, '已删除笔记'); assert.equal(archived.topic, null);
      assert.equal(f.store.sessions.get(archived.sessionId)?.title, '已删除笔记');
      assert.ok(f.store.sessions.get(archived.sessionId)?.archivedAt);
    });
    assert.equal(f.notes.get('other').body, '普通内容');
    assert.deepEqual(f.store.notes.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});
