import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { AssistantToolResultSchema, type CurrentViewSnapshot, type WindowNavigationTarget } from '@multivac/contracts';
import { SqliteAssistantStore, SqliteInternalToolCallRepository } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { InternalToolService, type InternalToolServices } from '../src/application/internal-tools/internal-tool-service.js';
import { READING_TOOLS } from '../src/application/internal-tools/reading-tools.js';
import { assistantQuoteDetails, readAssistantQuoteDetails } from '../src/runtime/executors/pi-quote-carriage.js';

test('收集真实读回、目标与来源版本去重、笔记改版不覆盖旧快照，书籍工具不读取正文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-collection-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const create = () => new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'), store.readingNotes, store.readingCollection);
  try {
    const service = create();
    const book = await service.import({ commandId: 'book1', title: '收集验证', author: '', format: 'txt', text: '这是不会被工具自动提供的正文。' });
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 0 }, end: { chapterId: 'c1', paragraphId: 'c1:p1', offset: 4 }, text: '这是不会' };
    const command = { commandId: 'collect1', targetId: 'reading-inbox', source: { kind: 'excerpt' as const, reference } };
    const collected = await service.collect(command);
    assert.deepEqual(await service.collect(command), collected);
    assert.deepEqual(await service.collect({ ...command, commandId: 'collect2' }), collected);
    assert.equal(service.collectionItems('reading-inbox').length, 1);
    const target = service.createCollectionTarget('target1', '读书资料');
    assert.deepEqual(service.createCollectionTarget('target1', '读书资料'), target);
    await assert.rejects(service.collect({ ...command, commandId: 'missing-target', targetId: 'missing' }), /接收目标/u);
    service.mutateNotes(book.id, { commandId: 'draft', expectedRevision: 0, action: 'draft', draft: { id: 'note1', body: '第一版笔记', origin: 'user', reference } });
    service.mutateNotes(book.id, { commandId: 'save', expectedRevision: 1, action: 'save' });
    const noteSource = { kind: 'reading-note' as const, bookId: book.id, noteId: 'note1', noteRevision: 1 };
    const first = await service.collect({ commandId: 'collect-note1', targetId: target.id, source: noteSource });
    service.mutateNotes(book.id, { commandId: 'edit', expectedRevision: 2, action: 'draft', draft: { id: 'note1', body: '第二版笔记', origin: 'user', reference } });
    service.mutateNotes(book.id, { commandId: 'save2', expectedRevision: 3, action: 'save' });
    await assert.rejects(service.collect({ commandId: 'old-version', targetId: target.id, source: noteSource }), /改变/u);
    const second = await service.collect({ commandId: 'collect-note2', targetId: target.id, source: { ...noteSource, noteRevision: 2 } });
    assert.notEqual(first.id, second.id); assert.equal(first.body, '第一版笔记');
    const quote = await service.resolveBookQuote({ sourceKind: 'book', sourceBook: reference, text: reference.text });
    const details = assistantQuoteDetails(quote); assert.deepEqual(readAssistantQuoteDetails(details), details);
    await assert.rejects(service.resolveBookQuote({ sourceKind: 'book', sourceBook: reference, text: '伪造内容' }), /不一致/u);
    const navigation: WindowNavigationTarget[] = [];
    const view: CurrentViewSnapshot = { panel: 'management', narrow: false, workspace: null, management: { page: 'reading', selection: null } };
    const tools = new InternalToolService({ tools: READING_TOOLS, services: { reading: service, windows: { navigate: (_id: string, target: WindowNavigationTarget) => { navigation.push(target); return true; }, isOpen: () => true } } as unknown as InternalToolServices, calls: new SqliteInternalToolCallRepository(store), currentTurn: () => ({ commandId: 'turn', windowId: 'window', view }) });
    const invoke = (toolName: string, toolCallId: string, args: unknown) => tools.invoke({ assistantSessionId: 'global-coordinator', toolName, toolCallId, args }, new AbortController().signal);
    const info = await invoke('get_book', 'info', { bookId: book.id });
    assert.ok(info.ok); if (info.ok) { assert.ok(Check(AssistantToolResultSchema, info.result)); assert.ok(!info.content.includes('这是不会被工具自动提供的正文')); }
    await invoke('open_book', 'open', { bookId: book.id, version: book.version, position: reference.start });
    await invoke('open_book', 'open', { position: reference.start, version: book.version, bookId: book.id });
    assert.equal(navigation.length, 1);
    const bad = await invoke('open_book', 'bad-open', { bookId: book.id, version: 'old', position: reference.start }); assert.ok(!bad.ok);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
    assert.equal(create().collectionItems(target.id).length, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
