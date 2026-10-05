import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { DatabaseSync } from 'node:sqlite';
import { Check } from 'typebox/value';
import { ReadingNoteDraftSchema, hasUnsavedReadingNote } from '@multivac/contracts';
import { assistantQuoteDetails, readAssistantQuoteDetails } from '../src/runtime/executors/pi-quote-carriage.js';

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

test('确认删除笔记时原子清理同名草稿，保留其他草稿，拒绝旧版本并幂等重试', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-delete-'));
  const store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const service = new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes);
    const book = await service.import({ commandId: 'book-delete', title: '删除确认', author: '', format: 'txt', text: '原文。' });
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 3 }, text: '原文。' };
    const draft = { id: 'note', body: '已保存', origin: 'user' as const, reference };
    service.mutateNotes(book.id, { commandId: 'd1', expectedRevision: 0, action: 'draft', draft });
    service.mutateNotes(book.id, { commandId: 's1', expectedRevision: 1, action: 'save' });
    service.mutateNotes(book.id, { commandId: 'd2', expectedRevision: 2, action: 'draft', draft: { ...draft, body: '未保存修改' } });
    const command = { commandId: 'confirmed-delete', expectedRevision: 3, action: 'delete' as const, id: draft.id, discardDraft: true };
    assert.throws(() => service.mutateNotes(book.id, { ...command, expectedRevision: 2 }), /其他窗口/u);
    assert.equal(service.notes(book.id).draft?.body, '未保存修改');
    const deleted = service.mutateNotes(book.id, command);
    assert.equal(deleted.notes.length, 0); assert.equal(deleted.draft, null);
    assert.deepEqual(service.mutateNotes(book.id, command), deleted);
    service.mutateNotes(book.id, { commandId: 'd3', expectedRevision: 4, action: 'draft', draft });
    service.mutateNotes(book.id, { commandId: 's2', expectedRevision: 5, action: 'save', nextDraft: { ...draft, id: 'other' } });
    const preserved = service.mutateNotes(book.id, { ...command, commandId: 'delete-other', expectedRevision: 6 });
    assert.equal(preserved.notes.length, 0); assert.equal(preserved.draft?.id, 'other');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('笔记位置独立保存，引用可移除，正文和位置在保存、重试及重启后不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-location-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const create = () => new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes, store.readingCollection);
    const service = create();
    const book = await service.import({ commandId: 'location-book', title: '位置与引用', author: '', format: 'txt', text: '第一段。\n\n第二段。' });
    const location = { bookId: book.id, version: book.version, position: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 1 } };
    const draft = { id: 'plain', body: '读到这里时想到的观点', origin: 'user' as const, location };
    assert.ok(Check(ReadingNoteDraftSchema, draft));
    assert.ok(!Check(ReadingNoteDraftSchema, { id: 'missing-position', body: '', origin: 'user' }));
    service.mutateNotes(book.id, { commandId: 'plain-draft', expectedRevision: 0, action: 'draft', draft });
    let state = service.mutateNotes(book.id, { commandId: 'plain-save', expectedRevision: 1, action: 'save' });
    assert.deepEqual(state.notes[0]!.location, location);
    assert.equal(state.notes[0]!.reference, undefined);
    const reference = { bookId: book.id, version: book.version, start: location.position, end: { ...location.position, offset: 3 }, text: '一段' };
    service.mutateNotes(book.id, { commandId: 'quote-draft', expectedRevision: 2, action: 'draft', draft: { ...draft, reference } });
    state = service.mutateNotes(book.id, { commandId: 'quote-save', expectedRevision: 3, action: 'save' });
    assert.ok(hasUnsavedReadingNote(state, draft));
    assert.throws(() => service.mutateNotes(book.id, { commandId: 'bad-position', expectedRevision: 4, action: 'draft', draft: { ...draft, location: { ...location, position: { ...location.position, offset: 100 } } } }), /位置无效/u);
    service.mutateNotes(book.id, { commandId: 'remove-quote', expectedRevision: 4, action: 'draft', draft });
    const save = { commandId: 'remove-save', expectedRevision: 5, action: 'save' as const };
    state = service.mutateNotes(book.id, save);
    assert.deepEqual(service.mutateNotes(book.id, save), state);
    assert.equal(state.notes[0]!.body, draft.body);
    assert.equal(state.notes[0]!.reference, undefined);
    assert.deepEqual(state.notes[0]!.location, location);
    const quote = await service.resolveBookQuote({ sourceKind: 'book', sourceBook: location, sourceNote: { id: draft.id, revision: 3 }, text: draft.body });
    assert.deepEqual(readAssistantQuoteDetails(assistantQuoteDetails(quote)), assistantQuoteDetails(quote));
    assert.ok(!('text' in quote.sourceBook));
    await assert.rejects(service.resolveBookQuote({ ...quote, text: '伪造的笔记' }), /不一致/u);
    await assert.rejects(service.resolveBookQuote({ ...quote, sourceBook: { ...location, position: { ...location.position, offset: 2 } } }), /来源已改变/u);
    const collected = await service.collect({ commandId: 'collect-plain', targetId: 'reading-inbox', source: { kind: 'reading-note', bookId: book.id, noteId: draft.id, noteRevision: 3 } });
    assert.equal(collected.reference, undefined);
    assert.deepEqual(collected.location, location);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
    assert.deepEqual(create().notes(book.id), state);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('旧笔记、草稿与命令回执补齐位置，保留摘录和版本，不被误判为未保存修改', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-note-legacy-'));
  const path = join(dir, 'db.sqlite');
  let store = new SqliteAssistantStore(path);
  try {
    const create = () => new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes);
    const service = create();
    const book = await service.import({ commandId: 'legacy-book', title: '旧笔记', author: '', format: 'txt', text: '原文。' });
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 3 }, text: '原文。' };
    const draft = { id: 'legacy', body: '旧记录', reference, origin: 'user' as const };
    const command = { commandId: 'legacy-draft', expectedRevision: 0, action: 'draft' as const, draft };
    service.mutateNotes(book.id, command);
    service.mutateNotes(book.id, { commandId: 'legacy-save', expectedRevision: 1, action: 'save', nextDraft: draft });
    store.close();
    // 模拟升级之前的磁盘记录及幂等回执，不改写原命令指纹。
    const database = new DatabaseSync(path);
    database.exec("UPDATE reading_notes_state SET record_json=json_remove(record_json, '$.draft.location', '$.notes[0].location'); UPDATE reading_notes_command SET result_json=json_remove(result_json, '$.draft.location', '$.notes[0].location')");
    database.close();
    store = new SqliteAssistantStore(path);
    const state = create().notes(book.id);
    assert.deepEqual(state.notes[0]!.location, { bookId: book.id, version: book.version, position: reference.start });
    assert.deepEqual(state.notes[0]!.reference, reference);
    assert.equal(state.revision, 2);
    assert.equal(hasUnsavedReadingNote(state), false);
    assert.equal(hasUnsavedReadingNote(state, draft), false);
    const replay = create().mutateNotes(book.id, command);
    assert.deepEqual(replay.draft!.location, state.draft!.location);
    assert.deepEqual(replay.draft!.reference, reference);
    assert.deepEqual(create().notes(book.id), state);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
