import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteAssistantService } from '../src/application/note-assistant-service.js';
import { NoteSuggestionsService } from '../src/application/note-suggestions-service.js';
import { NotesError } from '../src/modules/notes/note.js';
import { createNotesRequestHandler } from '../src/adapters/http/notes-routes.js';

async function fixture() {
  const base = join(process.cwd(), '.tmp'); await mkdir(base, { recursive: true });
  return mkdtemp(join(base, 'note-delete-test-'));
}
test('删除清理所有版本和引用、旧回执正文，重启与旧命令不能复活，其他笔记不受影响', async () => {
  const dir = await fixture(), path = join(dir, 'db.sqlite'); let store = new SqliteAssistantStore(path);
  try {
    let notes = new NotesService(store.notes);
    const assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'));
    const suggestions = new NoteSuggestionsService(store.noteSuggestions, assistant);
    const create = { commandId: 'create-a', id: 'a', title: 'A', body: '原句秘密内容' };
    notes.create(create); notes.create({ commandId: 'create-b', id: 'b', title: 'B', body: '其他笔记' });
    const root = assistant.ensureRoot('a'), other = assistant.ensureRoot('b');
    const contextInput = { commandId: 'context', id: 'context', sessionId: root.sessionId, revision: 1, selection: null };
    const snapshot = assistant.prepare('a', contextInput);
    const otherSnapshot = assistant.prepare('b', { ...contextInput, commandId: 'context-b', id: 'context-b', sessionId: other.sessionId });
    assistant.setResolvers(async () => [{ id: 'message', piSessionId: 'pi', piEntryId: 'message', role: 'assistant', createdAt: '2026-01-01', noteContext: snapshot, text: JSON.stringify({ suggestions: [{ reason: 'r', before: create.body, after: '修改后的秘密内容' }] }) }], async () => ({ provider: 'test', modelId: 'test', thinkingLevel: 'off' }));
    const imported = await suggestions.import('a', { commandId: 'import', sessionId: root.sessionId, piEntryId: 'message' });
    suggestions.decide('a', imported[0]!.id, { commandId: 'accept', expectedRevision: 1, decision: 'accept' });
    const update = { commandId: 'update', expectedRevision: 2, title: 'A2', body: '第三版秘密内容' };
    notes.update('a', update);
    const deletion = { commandId: 'delete', expectedRevision: 3 };
    assert.throws(() => notes.remove('a', { ...deletion, expectedRevision: 2 }), /版本已变化/u);
    assert.equal(notes.get('a').revision, 3);
    notes.setDeletionLifecycle({ check: () => { throw new NotesError('仍在回答', 409); }, release: () => {} });
    assert.throws(() => notes.remove('a', deletion), /仍在回答/u);
    assert.equal(notes.versions('a').versions.length, 3);
    notes.setDeletionLifecycle({ check: () => {}, release: () => {} });
    assert.deepEqual(notes.remove('a', deletion), { id: 'a', deleted: true });
    assert.deepEqual(notes.remove('a', deletion), { id: 'a', deleted: true });
    assert.throws(() => notes.remove('a', { ...deletion, expectedRevision: 4 }), /参数发生变化/u);
    assert.equal(notes.repository.count(), 1); assert.deepEqual(notes.list().map(note => note.id), ['b']);
    for (const revision of [undefined, 1, 2, 3]) assert.throws(() => notes.get('a', revision), /不存在|已删除/u);
    assert.throws(() => notes.versions('a'), /不存在/u);
    assert.throws(() => notes.create(create), /已删除/u);
    assert.throws(() => notes.create({ ...create, commandId: 'new-create' }), /身份已存在/u);
    assert.throws(() => notes.update('a', update), /已删除/u);
    assert.throws(() => assistant.prepare('a', contextInput), /已删除/u);
    assert.throws(() => assistant.ensureRoot('a'), /不存在/u);
    assert.throws(() => notes.operation(create.commandId), /已删除/u);
    await assert.rejects(suggestions.import('a', { commandId: 'import', sessionId: root.sessionId, piEntryId: 'message' }), /不存在/u);
    for (const table of ['app_note_version', 'app_note_context', 'app_note_suggestion']) assert.equal(Number(store.notes.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id='a'`).get()!.n), 0);
    assert.equal(Number(store.notes.database.prepare('SELECT COUNT(*) AS n FROM app_note_suggestion_source').get()!.n), 0);
    const receipts = store.notes.database.prepare('SELECT result_json FROM app_note_command').all().map(row => String(row.result_json)).join('\n');
    assert.ok(!receipts.includes('秘密内容'));
    assert.ok(store.getSession(root.sessionId)?.archivedAt); assert.equal(store.getSession(root.sessionId)?.host?.kind, 'note');
    assert.equal(notes.get('b').body, '其他笔记'); assert.deepEqual(assistant.context(other.sessionId, otherSnapshot.id).kind, 'note');
    assert.deepEqual(store.notes.database.prepare('PRAGMA foreign_key_check').all(), []);
    store.close(); store = new SqliteAssistantStore(path); notes = new NotesService(store.notes);
    assert.deepEqual(notes.remove('a', deletion), { id: 'a', deleted: true });
    assert.throws(() => notes.create(create), /已删除/u);
    assert.throws(() => notes.update('a', update), /已删除/u);
    assert.equal(notes.list().length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('删除中途失败回滚正文、版本、引用与回执，HTTP 校验版本并支持原命令重试', async () => {
  const dir = await fixture(), store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const notes = new NotesService(store.notes), assistant = new NoteAssistantService(store.noteAssistant, notes, join(dir, 'sessions'));
  const handler = createNotesRequestHandler(notes);
  const server = createServer((request, response) => { void handler(request, response); });
  try {
    notes.create({ id: 'a', commandId: 'a', title: 'A', body: '正文' });
    const root = assistant.ensureRoot('a'); assistant.prepare('a', { id: 'context', commandId: 'context', sessionId: root.sessionId, revision: 1, selection: null });
    const command = { commandId: 'delete', expectedRevision: 1 };
    store.notes.database.exec("CREATE TRIGGER fail_delete BEFORE UPDATE ON app_note WHEN json_extract(NEW.record_json,'$.deleted')=1 BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(() => notes.remove('a', command), /injected/u);
    assert.equal(notes.get('a').body, '正文'); assert.equal(notes.versions('a').versions.length, 1);
    assert.equal(store.noteAssistant.snapshot('context').revision, 1);
    assert.equal(notes.operation('a')?.body, '正文'); assert.equal(store.getSession(root.sessionId)?.archivedAt, null);
    store.notes.database.exec('DROP TRIGGER fail_delete');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
    const remove = (input: object) => fetch(`${base}/api/notes/a`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    for (const input of [{}, { ...command, expectedRevision: 0 }, { ...command, body: '伪造' }]) assert.equal((await remove(input)).status, 400);
    assert.equal((await remove({ ...command, expectedRevision: 2 })).status, 409);
    assert.equal((await remove(command)).status, 200); assert.equal((await remove(command)).status, 200);
    for (const suffix of ['', '/versions', '/versions/1']) assert.equal((await fetch(`${base}/api/notes/a${suffix}`)).status, 404);
    assert.equal((await remove({ ...command, commandId: 'other' })).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); }
});
