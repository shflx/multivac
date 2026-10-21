import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AssistantMessageView } from '@multivac/contracts';
import { GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { NotesService } from '../src/application/notes-service.js';
import { NoteImagesService } from '../src/application/note-images-service.js';
import { ImageService } from '../src/application/image-service.js';
import { NoteAssistantService } from '../src/application/note-assistant-service.js';
import { NoteSuggestionsService } from '../src/application/note-suggestions-service.js';
import { InternalToolService, type InternalToolServices } from '../src/application/internal-tools/index.js';
import { NOTE_TOOLS } from '../src/application/internal-tools/note-tools.js';
import { noteDiscussions, noteSources } from './fixtures/note-discussions.js';
import { testToolServices } from './fixtures/tool-services.js';

const png = (width = 12) => sharp({ create: { width, height: 8, channels: 3, background: 'blue' } }).png().toBuffer();

test('历史引用、未保存上传和冲突保守留存；恢复新版本幂等，重启可读，删除后不可复活', async () => {
  await mkdir('.tmp', { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.tmp/note-lifecycle-')), path = join(dir, 'db.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    let notes = new NotesService(store.notes, noteDiscussions()), images = new NoteImagesService(store.noteImages, notes);
    notes.create({ id: 'a', commandId: 'new', title: '文字兼容', body: '原始文字' });
    const data = await png(), image = await images.upload('a', data), draft = await images.upload('a', await png(13));
    const body = `前文\n\n![图](note-image:${image.id})\n\n后文`;
    const version = notes.update('a', { commandId: 'save-image', expectedRevision: 1, body });
    const removed = notes.update('a', { commandId: 'remove-image', expectedRevision: 2, body: '删除图片' });
    assert.throws(() => notes.update('a', { commandId: 'conflict', expectedRevision: 2, body: `![草稿](note-image:${draft.id})` }), /另一窗口/u);
    assert.equal(images.get('a', draft.id).retained, false);
    assert.equal(notes.operation('conflict'), undefined);
    store.database.exec('UPDATE app_note_image SET created_at=0');
    const sessionImages = new ImageService(store.images, join(dir, 'session-images'), () => {});
    await sessionImages.cleanup(); await sessionImages.cleanup();
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM app_note_image').get()!.n, 2);
    assert.deepEqual(images.read('a', image.id).data, data);
    assert.equal(notes.get('a', 2).body, body);
    store.close(); store = new SqliteAssistantStore(path);
    notes = new NotesService(store.notes, noteDiscussions()); images = new NoteImagesService(store.noteImages, notes);
    assert.equal(notes.get('a').body, removed.body);
    assert.deepEqual(images.read('a', image.id).data, data);
    assert.ok(images.read('a', draft.id).data.length);
    const restore = { commandId: 'restore', expectedRevision: 3, body: notes.get('a', 2).body, title: version.title };
    const restored = notes.update('a', restore);
    assert.equal(restored.revision, 4); assert.deepEqual(notes.update('a', restore), restored);
    assert.equal(notes.get('a', 2).body, body); assert.equal(notes.get('a', 3).body, removed.body);
    assert.deepEqual(notes.versions('a').versions.map(item => item.revision), [4, 3, 2, 1]);
    notes.update('a', { commandId: 'window-a', expectedRevision: 4, body: '窗口A' });
    assert.throws(() => notes.update('a', { commandId: 'window-b', expectedRevision: 4, body: `![草稿](note-image:${draft.id})` }), /另一窗口/u);
    const late = images.upload('a', await png(14)); await Promise.resolve();
    notes.remove('a', { commandId: 'delete', expectedRevision: 5 });
    await assert.rejects(late, /已删除/u);
    assert.throws(() => images.read('a', image.id), /已删除/u);
    assert.throws(() => notes.update('a', restore), /已删除/u);
    assert.throws(() => store.notes.writeVersion({ ...restored, revision: 6 }), /已删除/u);
    assert.throws(() => notes.create({ id: 'a', commandId: 'revive', title: '', body: '' }), /身份已存在/u);
    // 删除笔记也不在保护验证不完整时擅自回收二进制，但归属入口已封闭。
    assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM app_note_image').get()!.n, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('普通保存、实际建议接受及内部工具统一拒绝跨笔记和字符实体编码引用', async () => {
  const store = new SqliteAssistantStore(':memory:');
  const notes = new NotesService(store.notes, noteDiscussions()), images = new NoteImagesService(store.noteImages, notes);
  try {
    for (const id of ['a', 'b']) notes.create({ id, commandId: id, title: '', body: '唯一原文' });
    const image = await images.upload('a', await png());
    const cross = `![图](n&#111;te-image&#58;${image.id})`;
    let command = 0;
    for (const body of [cross, `![图][ref]\n\n[ref]: note-image&#58;${image.id}`, `![图](note-image:${image.id})`]) {
      assert.throws(() => notes.update('b', { commandId: `encoded-${command++}`, expectedRevision: 1, body }), /不属于/u);
    }
    const sources = noteSources(), assistant = new NoteAssistantService(store.noteAssistant, notes, '.tmp/note-sessions', sources);
    const suggestions = new NoteSuggestionsService(store.noteSuggestions, assistant);
    const root = assistant.ensureRoot('b');
    const snapshot = assistant.prepare('b', { id: 'snapshot', commandId: 'context', sessionId: root.sessionId, revision: 1, selection: null });
    const message: AssistantMessageView = { id: 'pi:entry', runtimeSessionId: 'pi', runtimeEntryId: 'entry', role: 'assistant', createdAt: '2026-01-01', noteContext: snapshot, text: JSON.stringify({ suggestions: [{ reason: '插图', before: '唯一原文', after: cross }] }) };
    Object.assign(sources, { history: async () => [message] });
    const [suggestion] = await suggestions.import('b', { commandId: 'import', sessionId: root.sessionId, runtimeEntryId: 'entry' });
    assert.throws(() => suggestions.decide('b', suggestion!.id, { commandId: 'accept', expectedRevision: 1, decision: 'accept' }), /不属于/u);
    assert.equal(suggestions.list('b')[0]!.status, 'pending');
    assert.equal(notes.get('b').body, '唯一原文'); assert.equal(notes.get('b').revision, 1);
    const tools = new InternalToolService({ tools: NOTE_TOOLS, services: testToolServices({ notes } as InternalToolServices), calls: store.internalToolCalls, currentTurn: () => ({ commandId: 'turn', windowId: 'window' }) });
    const invoke = (toolName: string, args: unknown) => tools.invoke({ assistantSessionId: GLOBAL_ASSISTANT_SESSION_ID, toolName, args, toolCallId: toolName }, new AbortController().signal);
    assert.equal((await invoke('update_note', { requestId: 'cross', noteId: 'b', revision: 1, patch: { body: cross } })).ok, false);
    assert.equal((await invoke('create_note', { requestId: 'new-cross', title: '', body: cross })).ok, false);
    assert.equal(notes.list().length, 2);
    assert.equal(images.get('a', image.id).retained, false);
    const own = notes.update('a', { commandId: 'own', expectedRevision: 1, body: cross });
    assert.equal(own.body, cross); assert.equal(images.get('a', image.id).retained, true);
  } finally { store.close(); }
});
