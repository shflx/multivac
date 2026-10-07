import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { BookSchema, BookIndexSchema, type BinaryBookImport } from '@multivac/contracts';
import { parseBinaryBook } from '../src/modules/reading/binary-book-import.js';
import { ReadingService } from '../src/application/reading-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { outlinePdf, textPdf } from './fixtures/binary-books.js';

const input = (source: Buffer): BinaryBookImport => ({ commandId: 'outline-import', title: '目录测试', author: '', format: 'pdf', dataBase64: source.toString('base64') });
async function* chunks(source: Buffer) { yield source; }

const expectedToc = [
  { id: 'toc1', title: '正文', depth: 0, position: null },
  { id: 'toc2', title: '第一章', depth: 1, position: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 } },
  { id: 'toc3', title: '第一节', depth: 2, position: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 } },
  { id: 'toc4', title: '第二章', depth: 1, position: { chapterId: 'c3', paragraphId: 'c3:p1', offset: 0 } },
  { id: 'toc5', title: '外部资源', depth: 0, position: null },
  { id: 'toc6', title: '失效目录', depth: 0, position: null },
];

test('PDF 两条导入流程保留中文层级和命名目标，失效与外链目标不影响正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-outline-'));
  let store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = outlinePdf();
    const legacy = await parseBinaryBook(input(source), source);
    assert.ok(Check(BookSchema, legacy));
    assert.deepEqual(legacy.toc, expectedToc);
    assert.deepEqual(legacy.chapters.map(chapter => chapter.title), ['第 1 页', '第 2 页', '第 3 页']);
    const service = new ReadingService(store.reading, join(root, 'books'));
    const summary = await service.importStream({ commandId: 'stream-outline', title: '目录测试', author: '', format: 'pdf' }, chunks(source), new AbortController().signal);
    const index = await service.prepareIndex(summary.id);
    assert.ok(Check(BookIndexSchema, index));
    assert.deepEqual(index.toc, expectedToc);
    assert.deepEqual(service.get(summary.id).chapters, legacy.chapters);
    assert.deepEqual(service.get(summary.id).toc, legacy.toc);
    assert.ok(!('toc' in summary));
    assert.ok(!('toc' in service.list()[0]!));
    const second = index.toc![3]!.position!;
    assert.equal(store.reading.content.block(summary.id, store.reading.content.position(summary.id, second)!.block).chapters.at(-1)!.paragraphs[0]!.text, 'Chapter two text.');
    store.close(); store = new SqliteAssistantStore(join(root, 'db'));
    assert.deepEqual(new ReadingService(store.reading, join(root, 'books')).index(summary.id).toc, expectedToc);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('已导入 PDF 仅补建目录并持久化，版本、正文、引用和标注不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-outline-old-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = outlinePdf();
    const old = await parseBinaryBook(input(source), source); delete old.toc;
    store.reading.import(old, 'old-import', 'old-fingerprint');
    const sourcePath = join(root, `${old.version}.pdf`); await writeFile(sourcePath, source);
    const service = new ReadingService(store.reading, root);
    assert.equal(service.index(old.id).toc, undefined);
    const reference = { bookId: old.id, version: old.version, start: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 }, end: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 17 }, text: 'Chapter one text.' };
    service.annotate(old.id, { commandId: 'bookmark-before', id: 'bookmark', expectedRevision: 0, action: 'save', kind: 'bookmark', reference });
    const annotations = service.annotations(old.id);
    // 首次索引迁移已完成，补目录不得重新保存任何正文块。
    store.reading.content.putBlock = () => { throw new Error('目录补建不应修改正文'); };
    const [first, concurrent] = await Promise.all([service.prepareIndex(old.id), service.prepareIndex(old.id)]);
    assert.deepEqual(first.toc, expectedToc);
    assert.deepEqual(concurrent, first);
    assert.equal(first.version, old.version);
    assert.deepEqual(service.get(old.id).chapters, old.chapters);
    assert.deepEqual(service.annotations(old.id), annotations);
    assert.ok(store.reading.content.validReference(old.id, reference));
    await rm(sourcePath);
    assert.deepEqual(await service.prepareIndex(old.id), first);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('无内嵌目录的 PDF 保留页列表，旧书缺失原文件仍可打开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-outline-fallback-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = textPdf();
    const book = await parseBinaryBook(input(source), source);
    assert.deepEqual(book.toc, []);
    delete book.toc;
    store.reading.import(book, 'old-import', 'fingerprint');
    const service = new ReadingService(store.reading, root);
    assert.equal((await service.prepareIndex(book.id)).toc, undefined);
    await writeFile(join(root, `${book.version}.pdf`), source);
    assert.deepEqual((await service.prepareIndex(book.id)).toc, []);
    assert.deepEqual(service.get(book.id).chapters, book.chapters);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('目录目标跨正文块时仍指向正确原始页，空白目标不伪造位置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-outline-blocks-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = textPdf(['a'.repeat(70000), '', 'Target chapter.'], 0, [{ title: '空白页', pageIndex: 1 }, { title: '目标章', pageIndex: 2 }], 0.005);
    const service = new ReadingService(store.reading, root);
    const summary = await service.importStream({ commandId: 'block-outline', title: '跨块', author: '', format: 'pdf' }, chunks(source), new AbortController().signal);
    const index = service.index(summary.id);
    assert.ok(index.blockCount > 1);
    assert.equal(index.toc![0]!.position, null);
    const target = index.toc![1]!.position!;
    const position = store.reading.content.position(summary.id, target)!;
    assert.ok(position.block > 0);
    assert.equal(service.window(summary.id, position.block).book.chapters.find(c => c.id === target.chapterId)!.paragraphs[0]!.text, 'Target chapter.');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
