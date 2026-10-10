import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Check } from 'typebox/value';
import { BookSchema, BookIndexSchema, referenceText, validBookReference, type Book } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { parseBinaryBook } from '../src/modules/reading/binary-book-import.js';
import { staticSvg } from '../src/modules/reading/epub-content.js';
import { xml } from '../src/modules/reading/epub-xml.js';
import { epub, illustratedEpubFiles } from './fixtures/binary-books.js';

async function sourceBook() {
  const files = illustratedEpubFiles();
  files['OPS/Images/cover.png'] = await sharp({ create: { width: 64, height: 96, channels: 4, background: '#445577' } }).png().toBuffer();
  files['OPS/Images/chart one.png'] = await sharp({ create: { width: 100, height: 40, channels: 4, background: '#aaccee' } }).png().toBuffer();
  return epub(files);
}
const metadata = { commandId: 'images-import', title: '图文验证', author: '', format: 'epub' as const };
async function* chunks(source: Buffer) { yield source; }

for (const stream of [false, true]) test(`EPUB ${stream ? '流式' : '兼容 JSON'} 导入保存封面、行内图表、SVG 与纯图片章节`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'epub-images-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = await sourceBook(), service = new ReadingService(store.reading, join(root, 'books'));
    const summary = stream ? await service.importStream(metadata, chunks(source), new AbortController().signal) : await service.import({ ...metadata, dataBase64: source.toString('base64') });
    const index = await service.prepareIndex(summary.id), book = service.get(summary.id);
    assert.ok(Check(BookSchema, book)); assert.ok(Check(BookIndexSchema, index));
    const images = book.chapters.flatMap(c => c.paragraphs.flatMap(p => p.images ?? []));
    assert.equal(images.length, 6); assert.equal(images.filter(image => image.resourceId).length, 4);
    assert.equal(images[0]!.width, 64); assert.equal(images[0]!.height, 96);
    assert.deepEqual(book.chapters[1]!.paragraphs.filter(p => p.text).map(p => [p.id, p.text]), [['c2:p1', '前文😀 后文。'], ['c2:p2', '图后正文。']]);
    assert.equal(book.chapters[1]!.paragraphs[0]!.images![0]!.offset, 5);
    assert.equal(book.chapters[2]!.paragraphs[0]!.text, '');
    assert.match(images.find(image => image.alt === '缺失图')!.error!, /缺少/);
    assert.match(images.find(image => image.alt === '外部图')!.error!, /内部/);
    for (const id of index.imageResources!) {
      const resource = await service.image(book.id, id); const info = await sharp(resource).metadata();
      assert.equal(info.format, 'png'); assert.ok(info.width! <= 1600 && info.height! <= 2000);
    }
    await assert.rejects(service.image(book.id, 'b'.repeat(64)), /不属于/);
    const image = book.chapters[2]!.paragraphs[0]!.images![0]!;
    const position = { chapterId: 'c3', paragraphId: book.chapters[2]!.paragraphs[0]!.id, offset: 0 };
    const text = referenceText(book, position, position, [image.id]);
    assert.match(text, /整页图表.*不能理解图像内容/);
    assert.doesNotMatch(text, /前文|图后正文/);
    assert.ok(store.reading.content.validReference(book.id, { bookId: book.id, version: book.version, start: position, end: position, imageIds: [image.id], text }));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('旧 EPUB 补建不改变引用、划线、书签、笔记和书伴身份；重新打开仍有效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epub-rebuild-'));
  let store = new SqliteAssistantStore(join(root, 'db'));
  const create = () => new ReadingService(store.reading, join(root, 'books'), undefined, join(root, 'sessions'), store.readingNotes);
  try {
    const source = await sourceBook();
    const parsed = await parseBinaryBook({ ...metadata, dataBase64: source.toString('base64') }, source);
    const legacy: Book = { ...parsed, chapters: parsed.chapters.map(c => ({ ...c, paragraphs: c.paragraphs.filter(p => p.text).map(({ images: _images, ...p }) => p) })), paragraphCount: 2 };
    store.reading.import(legacy, 'legacy', 'legacy-source');
    await mkdir(join(root, 'books')); await writeFile(join(root, 'books', `${legacy.version}.epub`), source);
    const service = create(), start = { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 }, end = { chapterId: 'c2', paragraphId: 'c2:p2', offset: 5 };
    const reference = { bookId: legacy.id, version: legacy.version, start, end, text: referenceText(legacy, start, end) };
    for (const kind of ['highlight', 'bookmark'] as const) service.annotate(legacy.id, { commandId: `old-${kind}`, id: kind, expectedRevision: 0, action: 'save', kind, reference });
    service.mutateNotes(legacy.id, { commandId: 'draft', expectedRevision: 0, action: 'draft', draft: { id: 'note', body: '历史笔记', origin: 'user', reference } });
    service.mutateNotes(legacy.id, { commandId: 'save', expectedRevision: 1, action: 'save' });
    const records = service.annotations(legacy.id), notes = service.notes(legacy.id), companion = service.ensureCompanion(legacy.id);
    const rebuilt = await service.prepareIndex(legacy.id);
    assert.equal(rebuilt.illustrationsVersion, 1); assert.equal(rebuilt.illustrationsNotice, undefined);
    assert.ok(validBookReference(service.get(legacy.id), reference));
    assert.deepEqual(service.annotations(legacy.id), records); assert.deepEqual(service.notes(legacy.id), notes);
    assert.equal(service.ensureCompanion(legacy.id).sessionId, companion.sessionId);
    store.close(); store = new SqliteAssistantStore(join(root, 'db'));
    assert.ok(store.reading.content.validReference(legacy.id, reference));
    assert.deepEqual(create().notes(legacy.id), notes); assert.deepEqual(create().annotations(legacy.id), records);
    // 模拟锚点改变：事务必须回滚，不能发布新正文。
    const current = create().get(legacy.id);
    assert.throws(() => store.reading.content.replaceIllustrations(rebuilt, [[{ ...current.chapters[1]!, paragraphs: [{ id: 'c2:p1', text: '不同正文' }] }]]), /不一致/);
    assert.deepEqual(create().get(legacy.id), current);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('原 EPUB 来源缺失时保留历史正文并明确反馈，不虚报补建成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epub-missing-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const source = await sourceBook(), parsed = await parseBinaryBook({ ...metadata, dataBase64: source.toString('base64') }, source);
    const old = { ...parsed, chapters: parsed.chapters.map(c => ({ ...c, paragraphs: c.paragraphs.filter(p => p.text).map(({ images: _images, ...p }) => p) })), paragraphCount: 2 };
    store.reading.import(old, 'missing-source', 'fingerprint');
    const service = new ReadingService(store.reading, join(root, 'books'));
    const index = await service.prepareIndex(old.id);
    assert.equal(index.illustrationsVersion, undefined); assert.match(index.illustrationsNotice!, /原 EPUB 文件不可用/);
    assert.deepEqual(service.get(old.id).chapters, old.chapters);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('SVG 仅允许静态白名单，拒绝脚本、事件、外部资源和样式注入', () => {
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg><use href="file:///secret"/></svg>', '<svg><rect fill="url(https://example.com/a)"/></svg>', '<svg style="background:url(file:///secret)"/>', String.raw`<svg><rect fill="u\72l(file:///secret)"/></svg>`, '<svg><rect fill="u/**/rl(file:///secret)"/></svg>']) assert.throws(() => staticSvg(xml(Buffer.from(svg))), /不支持|外部/);
  assert.doesNotThrow(() => staticSvg(xml(Buffer.from('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/></svg>'))));
});
