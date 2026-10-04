import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { BookSchema, ImportBookSchema, validBookReference, type BinaryBookImport } from '@multivac/contracts';
import { parseBinaryBook, decodeBookSource } from '../src/modules/reading/binary-book-import.js';
import { ReadingService } from '../src/application/reading-service.js';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { epub, epubFiles, textPdf } from './fixtures/binary-books.js';

const input = (format: 'pdf' | 'epub', source: Buffer): BinaryBookImport => ({ commandId: `import-${format}`, title: '导入书籍', author: '', format, dataBase64: source.toString('base64') });

for (const format of ['pdf', 'epub'] as const) {
  test(`${format} 真实导入、来源落盘、幂等和重启后稳定引用`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'multivac-binary-book-'));
    let store = new SqliteAssistantStore(join(root, 'db.sqlite'));
    try {
      const source = format === 'pdf' ? textPdf() : epub();
      const command = input(format, source);
      assert.ok(Check(ImportBookSchema, command));
      const service = new ReadingService(store.reading, join(root, 'books'));
      const book = await service.import(command);
      assert.ok(Check(BookSchema, book));
      assert.equal(book.format, format);
      assert.equal(book.chapters.length, 2);
      if (format === 'pdf') assert.deepEqual(book.chapters.map(chapter => chapter.paragraphs[0]!.text), ['First PDF page.', 'Second PDF page.']);
      else {
        assert.deepEqual(book.chapters.map(chapter => chapter.title), ['第一章', '第二章']);
        assert.ok(book.chapters[0]!.paragraphs.some(p => p.text === '第一章真实正文😀 & 引用。'));
        assert.doesNotMatch(JSON.stringify(book), /不要执行|不要显示|tracker/u);
      }
      assert.deepEqual(await readFile(join(root, 'books', `${book.version}.${format}`)), source);
      assert.deepEqual(await service.import(command), book);
      assert.deepEqual(await service.import({ ...command, commandId: 'same-file', title: '别名' }), book);
      await assert.rejects(service.import({ ...command, title: '冲突' }), /同一命令/u);
      const paragraph = book.chapters[0]!.paragraphs[0]!;
      const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c1', paragraphId: paragraph.id, offset: 0 }, end: { chapterId: 'c1', paragraphId: paragraph.id, offset: paragraph.text.length }, text: paragraph.text };
      assert.ok(validBookReference(book, reference));
      store.close(); store = new SqliteAssistantStore(join(root, 'db.sqlite'));
      const restored = new ReadingService(store.reading, join(root, 'books')).get(book.id);
      assert.deepEqual(restored, book);
      assert.ok(validBookReference(restored, reference));
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('拒绝伪造文件、错误编码及没有文本的扫描 PDF', async () => {
  assert.equal(Check(ImportBookSchema, { commandId: 'bad', title: 'bad', author: '', format: 'pdf', text: '不是 PDF' }), false);
  assert.throws(() => decodeBookSource({ ...input('pdf', Buffer.from('bad')), dataBase64: 'not base64' }), /编码/u);
  await assert.rejects(parseBinaryBook(input('pdf', Buffer.from('bad')), Buffer.from('bad')), /有效的 PDF/u);
  await assert.rejects(parseBinaryBook(input('pdf', textPdf([''])), textPdf([''])), /扫描版暂不支持 OCR/u);
  await assert.rejects(parseBinaryBook(input('epub', Buffer.from('bad')), Buffer.from('bad')), /损坏/u);
});

test('EPUB 按 spine 阅读，拒绝缺失、外部与越界正文路径及实体声明', async () => {
  for (const href of ['missing.xhtml', 'https://example.com/book.xhtml', '../../outside.xhtml']) {
    const files = epubFiles(); files['OPS/book.opf'] = files['OPS/book.opf']!.replace('first.xhtml', href);
    const source = epub(files);
    await assert.rejects(parseBinaryBook(input('epub', source), source), /缺少|内部|超出/u);
  }
  const files = epubFiles();
  files['OPS/first.xhtml'] = '<!DOCTYPE html [<!ENTITY leak SYSTEM "file:///secret">]><html><body><p>&leak;</p></body></html>';
  const source = epub(files);
  await assert.rejects(parseBinaryBook(input('epub', source), source), /实体声明/u);
});

test('EPUB 拒绝加密正文，未使用的混淆字体不妨碍文字阅读', async () => {
  const files = epubFiles();
  files['META-INF/encryption.xml'] = '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/first.xhtml"/></CipherData></EncryptedData></encryption>';
  let source = epub(files);
  await assert.rejects(parseBinaryBook(input('epub', source), source), /正文已加密/u);
  files['META-INF/encryption.xml'] = files['META-INF/encryption.xml'].replace('first.xhtml', 'font.otf');
  source = epub(files);
  assert.equal((await parseBinaryBook(input('epub', source), source)).chapters.length, 2);
});

test('EPUB 解压前拒绝过大的单项资源', async () => {
  const files = epubFiles(); files['large.txt'] = 'x'.repeat(16 * 1024 * 1024 + 1);
  const source = epub(files);
  await assert.rejects(parseBinaryBook(input('epub', source), source), /解压内容超过限制/u);
});


test('EPUB 正文支持 UTF-16 XML 编码与中文来源', async () => {
  const files: Record<string, string | Uint8Array> = epubFiles();
  files['OPS/first.xhtml'] = Buffer.from('\uFEFF' + files['OPS/first.xhtml'], 'utf16le');
  const source = epub(files);
  const book = await parseBinaryBook(input('epub', source), source);
  assert.ok(book.chapters[0]!.paragraphs.some(p => p.text === '第一章真实正文😀 & 引用。'));
});
