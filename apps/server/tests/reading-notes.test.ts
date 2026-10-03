import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';

test('笔记草稿与保存分开，切换需显式决定，版本冲突不覆盖，重启保留记录和来源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-reading-notes-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const create = () => new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes);
  try {
    const service = create();
    const book = await service.import({ commandId: 'book1', title: '笔记原文', author: '', format: 'txt', text: '第一段。\n\n第二段。' });
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 4 }, text: '第一段。' };
    const draft = { id: 'note1', reference, body: '我的草稿', origin: 'user' as const };
    const cmd = { commandId: 'draft1', expectedRevision: 0, action: 'draft' as const, draft };
    const state = service.mutateNotes(book.id, cmd);
    assert.equal(state.notes.length, 0); assert.deepEqual(service.mutateNotes(book.id, cmd), state);
    assert.throws(() => service.mutateNotes(book.id, { ...cmd, commandId: 'stale', draft: { ...draft, body: '覆盖' } }), /其他窗口/u);
    assert.throws(() => service.mutateNotes(book.id, { ...cmd, commandId: 'replace', expectedRevision: 1, draft: { ...draft, id: 'note2' } }), /先保存/u);
    const saved = service.mutateNotes(book.id, { commandId: 'save1', expectedRevision: 1, action: 'save', nextDraft: { ...draft, id: 'note2', body: '' } });
    assert.equal(saved.notes[0]!.body, '我的草稿'); assert.equal(saved.draft!.id, 'note2');
    const discarded = service.mutateNotes(book.id, { commandId: 'discard1', expectedRevision: 2, action: 'draft', draft: null, discardExisting: true });
    assert.equal(discarded.draft, null);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
    assert.deepEqual(create().notes(book.id), discarded);
    const edited = create().mutateNotes(book.id, { commandId: 'edit1', expectedRevision: 3, action: 'draft', draft: { ...draft, body: '修改后' } });
    assert.equal(edited.draft!.reference.text, '第一段。');
    assert.throws(() => create().mutateNotes(book.id, { commandId: 'delete-dirty', expectedRevision: 4, action: 'delete', id: 'note1' }), /未保存/u);
    create().mutateNotes(book.id, { commandId: 'save2', expectedRevision: 4, action: 'save' });
    assert.equal(create().notes(book.id).notes[0]!.revision, 2);
    const deleted = create().mutateNotes(book.id, { commandId: 'delete1', expectedRevision: 5, action: 'delete', id: 'note1' });
    assert.equal(deleted.notes.length, 0);
    assert.deepEqual(create().mutateNotes(book.id, { commandId: 'delete1', expectedRevision: 5, action: 'delete', id: 'note1' }), deleted);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
