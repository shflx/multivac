import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { BookSchema, referenceText, positionRank, type ImportBook } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { parseBook } from '../src/modules/reading/book-import.js';

const input: ImportBook = { commandId: 'import-1', title: '真实文本', author: '作者', format: 'md', text: '# 第一章\n\n你好😀。\n\n第二段。\n\n# 第二章\n\n**结束**。[链接](https://example.com)\n\n<script>bad()</script>\n\n![图片](https://example.com/remote.png)' };
test('Markdown 正文以章节和稳定段落保存，不执行 HTML 或远程资源', () => {
  const book = parseBook(input);
  assert.ok(Check(BookSchema, book));
  assert.equal(book.paragraphCount, 3);
  assert.deepEqual(book.chapters.map(c => c.title), ['正文', '第一章', '第二章']);
  assert.equal(book.chapters[2]!.paragraphs[0]!.text, '结束。链接');
  assert.equal(book.version, parseBook(input).version);
  const start = { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 };
  const end = { chapterId: 'c2', paragraphId: 'c2:p2', offset: 3 };
  assert.equal(referenceText(book, start, end), '你好😀。\n第二段');
  assert.equal(positionRank(book, { ...start, offset: 3 }), -1);
});
test('拒绝空正文、非法字符、超长段落与超限正文', () => {
  for (const text of ['   ', '\u0000bad', 'x'.repeat(16385), 'x'.repeat(1024 * 1024 + 1), Array.from({ length: 5001 }, () => 'x').join('\n\n')]) {
    assert.throws(() => parseBook({ ...input, format: 'txt', text }));
  }
});
test('导入来源落盘、重复命令核对参数、同正文去重及重启恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-reading-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const service = new ReadingService(store.reading, join(dir, 'books'));
    const book = await service.import(input);
    assert.equal(await readFile(join(dir, 'books', `${book.version}.md`), 'utf8'), input.text);
    assert.deepEqual(await service.import(input), book);
    assert.deepEqual(await service.import({ ...input, commandId: 'import-2', title: '别名' }), book);
    await assert.rejects(service.import({ ...input, title: '冲突标题' }), /同一命令/u);
    assert.equal(service.list().length, 1);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
    assert.deepEqual(new ReadingService(store.reading, join(dir, 'books')).get(book.id), book);
    assert.throws(() => new ReadingService(store.reading, join(dir, 'books')).get('../not-a-book'), /不存在/u);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
