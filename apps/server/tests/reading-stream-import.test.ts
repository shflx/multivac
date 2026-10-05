import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { BookIndexSchema, type BookUpload } from '@multivac/contracts';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
import { ReadingService } from '../src/application/reading-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { epub, epubFiles, textPdf } from './fixtures/binary-books.js';

async function* chunks(buffer: Buffer) { for (let offset = 0; offset < buffer.length; offset += 16384) yield buffer.subarray(offset, offset + 16384); }
const metadata = (format: 'pdf' | 'epub'): BookUpload => ({ commandId: `stream-${format}`, title: '流式书籍', author: '', format });

for (const format of ['pdf', 'epub'] as const) {
  test(`${format} 文件流进入独立解析线程，原文件落盘且与旧导入保持相同版本和正文`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'reading-stream-'));
    const store = new SqliteAssistantStore(join(root, 'db'));
    try {
      const events = new WorkbenchEvents(); let changed = 0; events.subscribe(() => changed++);
      const service = new ReadingService(store.reading, join(root, 'books'), events);
      const source = format === 'pdf' ? textPdf() : epub();
      const input = metadata(format);
      const summary = await service.importStream(input, chunks(source), new AbortController().signal);
      assert.ok(!('chapters' in summary));
      assert.ok(Check(BookIndexSchema, service.index(summary.id)));
      const window = service.window(summary.id, 0);
      const old = await service.import({ ...input, commandId: 'legacy-retry', dataBase64: source.toString('base64') });
      assert.equal(old.version, summary.version);
      assert.deepEqual(old.chapters, window.book.chapters);
      assert.deepEqual(await service.importStream(input, chunks(source), new AbortController().signal), summary);
      assert.equal(changed, 1);
      assert.deepEqual(await readFile(join(root, 'books', `${summary.version}.${format}`)), source);
      assert.ok(!(await readdir(join(root, 'books'))).some(name => name.startsWith('.import-')));
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('大正文分块保存、引用只读相关块，已读尾部裁剪，旧书迁移与重启不改变锚点', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-blocks-'));
  let store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const service = new ReadingService(store.reading, join(root, 'books'), undefined, join(root, 'sessions'));
    const book = await service.import({ commandId: 'old-book', title: '旧书', author: '', format: 'txt', text: Array.from({ length: 250 }, (_, i) => `${i}段正文😀`.repeat(80)).join('\n\n') });
    const index = service.index(book.id);
    assert.ok(index.blockCount > 1);
    const first = service.window(book.id, 0), last = service.window(book.id, index.blockCount - 1);
    assert.ok(JSON.stringify(first).length < 100000);
    assert.notDeepEqual(first.book.chapters, last.book.chapters);
    const chapter = last.book.chapters.at(-1)!, paragraph = chapter.paragraphs.at(-1)!;
    const reference = { bookId: book.id, version: book.version, start: { chapterId: chapter.id, paragraphId: paragraph.id, offset: 0 }, end: { chapterId: chapter.id, paragraphId: paragraph.id, offset: paragraph.text.length }, text: paragraph.text };
    // 若这些操作退回整本读取，测试直接失败。
    store.reading.get = () => { throw new Error('不应读取整本正文'); };
    assert.ok(store.reading.content.validReference(book.id, reference));
    assert.equal(store.reading.content.validReference(book.id, { ...reference, text: reference.text.replace('正文', '伪造') }), false);
    const companion = service.ensureCompanion(book.id);
    service.setScope(book.id, { commandId: 'mark', expectedRevision: 0, boundary: reference.end });
    const context = service.context(companion.sessionId, reference);
    assert.equal(context.kind, 'reading');
    if (context.kind === 'reading') { assert.equal([...context.excerpt].length, 16000); assert.equal(context.truncated, true); assert.ok(context.excerpt.endsWith(paragraph.text)); }
    assert.equal(service.list()[0]!.id, book.id);
    store.close(); store = new SqliteAssistantStore(join(root, 'db'));
    assert.deepEqual(store.reading.content.full(book.id), book);
    assert.ok(store.reading.content.validReference(book.id, reference));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('不解压未使用的大资源，超过旧文件和提取总量限制的 EPUB 可以导入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-large-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const files: Record<string, string | Uint8Array> = epubFiles();
    // 不可压缩的无关资源让原文件超过旧 20 MiB 上限，导入只读取正文条目。
    const { randomBytes } = await import('node:crypto');
    files['OPS/unused-image.bin'] = randomBytes(21 * 1024 * 1024);
    const paragraphs = Array.from({ length: 700 }, () => '<p>' + '大书正文。'.repeat(1000) + '</p>').join('');
    files['OPS/first.xhtml'] = `<html><body>${paragraphs}</body></html>`;
    const source = epub(files);
    assert.ok(source.length > 20 * 1024 * 1024);
    const service = new ReadingService(store.reading, join(root, 'books'));
    const saved = await service.importStream(metadata('epub'), chunks(source), new AbortController().signal);
    const index = service.index(saved.id);
    assert.ok(index.blockCount > 40);
    assert.ok(JSON.stringify(service.window(saved.id, 0)).length < 100000);
    assert.ok(!JSON.stringify(index).includes('大书正文'));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('取消与解析失败清理临时文件，不发布半本书，取消后可以再次导入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-cancel-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const service = new ReadingService(store.reading, join(root, 'books'));
    const controller = new AbortController();
    async function* cancelled() { yield Buffer.from('start'); controller.abort(); yield Buffer.from('end'); }
    await assert.rejects(service.importStream(metadata('pdf'), cancelled(), controller.signal));
    await assert.rejects(service.importStream(metadata('epub'), chunks(Buffer.from('invalid')), new AbortController().signal), /损坏/u);
    assert.deepEqual(service.list(), []);
    assert.deepEqual(await readdir(join(root, 'books')), []);
    const source = textPdf();
    await service.importStream(metadata('pdf'), chunks(source), new AbortController().signal);
    assert.equal(service.list().length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});


test('大 PDF 不必整本进入解析内存，取消已启动的解析后清理现场', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reading-large-pdf-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const service = new ReadingService(store.reading, join(root, 'books'));
    const source = textPdf(['Large file, small text.'], 21 * 1024 * 1024);
    const summary = await service.importStream(metadata('pdf'), chunks(source), new AbortController().signal);
    assert.equal(service.window(summary.id, 0).book.chapters[0]!.paragraphs[0]!.text, 'Large file, small text.');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function* uploadThenCancel() { yield textPdf(); timer = setTimeout(() => controller.abort(), 40); }
    try { await assert.rejects(service.importStream({ ...metadata('pdf'), commandId: 'cancel-worker' }, uploadThenCancel(), controller.signal), /取消/u); }
    finally { clearTimeout(timer); }
    assert.equal(service.list().length, 1);
    assert.ok(!(await readdir(join(root, 'books'))).some(name => name.startsWith('.import-')));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
