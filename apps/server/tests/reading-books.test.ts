import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Check } from 'typebox/value';
import { BookSchema, referenceText, positionRank, type ImportBook } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { WorkbenchEvents } from '../src/application/workbench-events.js';
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

test('标注核对原文、版本与 Unicode，CRUD 回执不会重复写入或发布事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-annotations-'));
  const store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const events = new WorkbenchEvents(); let changed = 0;
    const service = new ReadingService(store.reading, join(dir, 'books'), events);
    assert.deepEqual(service.list(), []);
    assert.deepEqual(service.discussions(), []);
    const book = await service.import(input);
    events.subscribe(() => changed++);
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 }, end: { chapterId: 'c2', paragraphId: 'c2:p2', offset: 3 }, text: '你好😀。\n第二段' };
    const command = { commandId: 'mark-1', id: 'mark-1', expectedRevision: 0, kind: 'highlight' as const, action: 'save' as const, reference };
    const saved = service.annotate(book.id, command);
    assert.equal(saved.record!.revision, 1);
    assert.deepEqual(service.annotate(book.id, command), saved);
    assert.equal(changed, 1);
    assert.throws(() => service.annotate(book.id, { ...command, commandId: 'bad', id: 'bad', reference: { ...reference, version: 'old' } }), /失效/u);
    assert.throws(() => service.annotate(book.id, { ...command, commandId: 'bad', id: 'bad', reference: { ...reference, text: '伪造' } }), /失效/u);
    assert.throws(() => service.annotate(book.id, { ...command, commandId: 'stale' }), /其他窗口/u);
    const deletion = { ...command, commandId: 'delete-1', expectedRevision: 1, action: 'delete' as const };
    service.annotate(book.id, deletion); service.annotate(book.id, deletion);
    assert.equal(service.annotations(book.id).length, 0); assert.equal(changed, 2);
    assert.deepEqual(service.annotate(book.id, command), saved);
    assert.equal(service.annotations(book.id).length, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('书伴宿主独立持久化，显式已读范围裁剪正文且不提供未来章节', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-reading-scope-'));
  const store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  try {
    const service = new ReadingService(store.reading, join(dir, 'books'), undefined, join(dir, 'work'));
    const book = await service.import(input);
    const discussion = service.ensureCompanion(book.id);
    assert.deepEqual(service.ensureCompanion(book.id), discussion);
    assert.equal(store.getSession(discussion.sessionId)!.host!.bookId, book.id);
    assert.equal(store.listSessions(null, 'work').length, 0);
    const p = book.chapters[1]!.paragraphs[0]!;
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c2', paragraphId: p.id, offset: 0 }, end: { chapterId: 'c2', paragraphId: p.id, offset: p.text.length }, text: p.text };
    const before = service.context(discussion.sessionId, reference);
    assert.equal(before.kind, 'reading');
    if (before.kind !== 'reading') throw new Error('wrong context');
    assert.equal(before.excerpt, '');
    const scopeCommand = { commandId: 'scope1', expectedRevision: 0, boundary: reference.end };
    const scope = service.setScope(book.id, scopeCommand);
    assert.deepEqual(service.setScope(book.id, scopeCommand), scope);
    const after = service.context(discussion.sessionId, reference);
    if (after.kind !== 'reading') throw new Error('wrong context');
    assert.equal(after.excerpt, p.text);
    assert.ok(!JSON.stringify(after).includes('结束'));
    assert.throws(() => service.context(discussion.sessionId, { ...reference, bookId: 'other' }), /不属于/u);
    service.setScope(book.id, { commandId: 'reset', expectedRevision: 1, boundary: null });
    const reset = service.context(discussion.sessionId, reference);
    if (reset.kind === 'reading') assert.equal(reset.excerpt, '');
    assert.equal(after.excerpt, p.text);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
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

test('删除书籍清理正文和阅读状态，保留笔记讨论，幂等重试与重新导入可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'multivac-book-delete-'));
  let store = new SqliteAssistantStore(join(dir, 'db.sqlite'));
  const events = new WorkbenchEvents();
  const create = () => new ReadingService(store.reading, join(dir, 'books'), events, join(dir, 'work'), store.readingNotes, store.readingCollection);
  try {
    let service = create();
    const book = await service.import(input);
    const other = await service.import({ ...input, commandId: 'other-book', text: '# 另一章\n\n另一本文字。' });
    const reference = { bookId: book.id, version: book.version, start: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 }, end: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 5 }, text: '你好😀。' };
    // 首次读取建立正文索引，覆盖分块正文与外键清理。
    service.index(book.id);
    service.annotate(book.id, { commandId: 'bookmark', id: 'bookmark', expectedRevision: 0, action: 'save', kind: 'bookmark', reference });
    service.setScope(book.id, { commandId: 'read-scope', expectedRevision: 0, boundary: reference.end });
    service.mutateNotes(book.id, { commandId: 'note-draft', expectedRevision: 0, action: 'draft', draft: { id: 'note', reference, body: '保留的笔记', origin: 'user' } });
    const notes = service.mutateNotes(book.id, { commandId: 'note-save', expectedRevision: 1, action: 'save' });
    const discussion = service.ensureCompanion(book.id);
    const collected = await service.collect({ commandId: 'collect-excerpt', targetId: 'reading-inbox', source: { kind: 'excerpt', reference } });
    let changed = 0;
    events.subscribe(event => { if (event.type === 'reading.changed' && event.bookId === book.id) changed++; });
    assert.deepEqual(service.remove(book.id).books.map(b => b.id), [other.id]);
    assert.deepEqual(service.remove(book.id).books.map(b => b.id), [other.id]);
    assert.equal(changed, 1);
    for (const read of [() => service.get(book.id), () => service.index(book.id), () => service.window(book.id, 0)]) {
      assert.throws(read, error => error instanceof Error && 'status' in error && error.status === 404);
    }
    assert.deepEqual(service.annotations(book.id), []);
    assert.deepEqual(service.notes(book.id), notes);
    assert.deepEqual(service.discussion(discussion.sessionId), discussion);
    assert.deepEqual(service.collectionItems('reading-inbox'), [collected]);
    store.close(); store = new SqliteAssistantStore(join(dir, 'db.sqlite')); service = create();
    assert.deepEqual(service.list().map(b => b.id), [other.id]);
    const restored = await service.import(input);
    assert.equal(restored.id, book.id);
    assert.deepEqual(service.annotations(book.id), []);
    assert.equal(service.scope(book.id).boundary, null);
    assert.deepEqual(service.notes(book.id), notes);
    assert.deepEqual(service.ensureCompanion(book.id), discussion);
    // 未生成索引的书籍同样可以删除。
    service.remove(other.id);
    assert.deepEqual(service.list().map(b => b.id), [book.id]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
