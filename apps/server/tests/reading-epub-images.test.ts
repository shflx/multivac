import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Check } from 'typebox/value';
import { BookSchema, BookIndexSchema, referenceText } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { staticSvg, readingImageType } from '../src/modules/reading/epub-content.js';
import { xml } from '../src/modules/reading/epub-xml.js';
import { epub, illustratedEpubFiles } from './fixtures/binary-books.js';
import { unreadableReadingHistory } from './fixtures/reading-history.js';

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
    const source = await sourceBook(), service = new ReadingService({ repository: store.reading, sourceDir: join(root, 'books'), history: unreadableReadingHistory });
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
    // 来源文件不参与后续阅读；重复读取与重启直接复用导入时保存的图文。
    await rm(join(root, 'books', `${book.version}.epub`));
    assert.deepEqual(await service.prepareIndex(book.id), index);
    const reopened = new SqliteAssistantStore(join(root, 'db'));
    try {
      const reading = new ReadingService({ repository: reopened.reading, sourceDir: join(root, 'books'), history: unreadableReadingHistory });
      assert.deepEqual(await reading.prepareIndex(book.id), index);
      assert.deepEqual(reading.get(book.id), book);
      for (const id of index.imageResources!) assert.deepEqual(await reading.image(book.id, id), await service.image(book.id, id));
    } finally { reopened.close(); }
    await assert.rejects(service.image(book.id, 'b'.repeat(64)), /不属于/);
    const image = book.chapters[2]!.paragraphs[0]!.images![0]!;
    const position = { chapterId: 'c3', paragraphId: book.chapters[2]!.paragraphs[0]!.id, offset: 0 };
    const text = referenceText(book, position, position, [image.id]);
    assert.match(text, /整页图表.*不能理解图像内容/);
    assert.doesNotMatch(text, /前文|图后正文/);
    assert.ok(store.reading.content.validReference(book.id, { bookId: book.id, version: book.version, start: position, end: position, imageIds: [image.id], text }));
    // 图片资源清单按书缓存，删除后不能继续凭缓存提供图片。
    service.remove(book.id);
    await assert.rejects(service.image(book.id, index.imageResources![0]!), /不存在/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('扫描版 JPEG 保持 JPEG 编码并按文件头返回类型，其余图片仍为 PNG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epub-jpeg-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  try {
    const files = illustratedEpubFiles();
    files['OPS/Text/two.xhtml'] = '<html><head><title>扫描页</title></head><body><img src="../Images/scan.jpg" alt="扫描页"/></body></html>';
    files['OPS/Images/scan.jpg'] = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#dddddd', noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).jpeg().toBuffer();
    const service = new ReadingService({ repository: store.reading, sourceDir: join(root, 'books'), history: unreadableReadingHistory });
    const book = service.get((await service.import({ ...metadata, commandId: 'jpeg-import', dataBase64: epub(files).toString('base64') })).id);
    const scan = book.chapters[2]!.paragraphs[0]!.images![0]!;
    const data = await service.image(book.id, scan.resourceId!);
    assert.equal((await sharp(data).metadata()).format, 'jpeg');
    assert.equal(readingImageType(data), 'image/jpeg');
    assert.ok(data.byteLength < (await sharp(data).png().toBuffer()).byteLength);
    const others = (await service.prepareIndex(book.id)).imageResources!.filter(id => id !== scan.resourceId);
    assert.ok(others.length);
    for (const id of others) assert.equal(readingImageType(await service.image(book.id, id)), 'image/png');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('SVG 仅允许静态白名单，拒绝脚本、事件、外部资源和样式注入', () => {
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg onload="alert(1)"/>', '<svg><use href="file:///secret"/></svg>', '<svg><rect fill="url(https://example.com/a)"/></svg>', '<svg style="background:url(file:///secret)"/>', String.raw`<svg><rect fill="u\72l(file:///secret)"/></svg>`, '<svg><rect fill="u/**/rl(file:///secret)"/></svg>']) assert.throws(() => staticSvg(xml(Buffer.from(svg))), /不支持|外部/);
  assert.doesNotThrow(() => staticSvg(xml(Buffer.from('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/></svg>'))));
});
