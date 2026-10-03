import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';

test('讨论真实父子关系与回执、固定消息来源和笔记出处，伪造来源不写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-discussions-'));
  const store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const service = new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes);
    const book = await service.import({ commandId: 'import', title: '来源验证', author: '', format: 'txt', text: '固定的原文。' });
    const root = service.ensureCompanion(book.id);
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 6 }, text: '固定的原文。' };
    const source = { sessionId: root.sessionId, piEntryId: 'pi-answer1' };
    service.setHistoryResolver(async () => [{ id: 'm1', piSessionId: 'pi-root', piEntryId: source.piEntryId, text: '真实历史回答', role: 'assistant', createdAt: new Date().toISOString(), readingReference: reference }]);
    const command = { commandId: 'child-command', sessionId: 'reading-child', parentSessionId: root.sessionId, source: { kind: 'message' as const, message: source } };
    const child = await service.createDiscussion(book.id, command);
    assert.equal(child.parentSessionId, root.sessionId); assert.deepEqual(child.reference, reference); assert.equal(child.sourceMessage!.text, '真实历史回答');
    assert.deepEqual(await service.createDiscussion(book.id, command), child);
    assert.equal(service.discussions(book.id).length, 2);
    await assert.rejects(service.createDiscussion(book.id, { ...command, source: { kind: 'selection', reference } }), /参数冲突/u);
    await assert.rejects(service.createDiscussion(book.id, { ...command, commandId: 'bad-child', sessionId: 'bad-child', source: { kind: 'message', message: { ...source, piEntryId: 'fake' } } }), /来源消息/u);
    const context = await service.contextForRefs(root.sessionId, [{ kind: 'book', reference, sourceMessage: source }]);
    if (context.kind === 'reading') assert.equal(context.discussionExcerpt, '真实历史回答');
    const draft = { id: 'note1', body: '自己的理解', origin: 'companion' as const, reference, discussion: source };
    const draftCommand = { commandId: 'note-draft', expectedRevision: 0, action: 'draft' as const, draft };
    await service.prepareNotes(book.id, draftCommand);
    service.mutateNotes(book.id, draftCommand);
    await service.prepareNotes(book.id, { commandId: 'note-save', expectedRevision: 1, action: 'save' });
    const saved = service.mutateNotes(book.id, { commandId: 'note-save', expectedRevision: 1, action: 'save' });
    assert.deepEqual(saved.notes[0]!.discussion, source);
    await assert.rejects(service.prepareNotes(book.id, { ...draftCommand, commandId: 'fake-note', expectedRevision: 2, draft: { ...draft, id: 'fake-note', discussion: { ...source, piEntryId: 'fake' } } }), /来源消息/u);
    assert.equal(service.notes(book.id).notes.length, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
