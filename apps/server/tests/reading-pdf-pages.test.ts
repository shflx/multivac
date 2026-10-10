import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceText, type BookReference } from '@multivac/contracts';
import { SqliteAssistantStore } from '../src/storage/sqlite-assistant-store.js';
import { ReadingService } from '../src/application/reading-service.js';
import { createReadingRequestHandler } from '../src/adapters/http/reading-routes.js';
import { textPdf } from './fixtures/binary-books.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reading-pdf-page-'));
  const store = new SqliteAssistantStore(join(root, 'db'));
  const service = new ReadingService(store.reading, join(root, 'books'), undefined, join(root, 'sessions'));
  return { root, store, service, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
const reference = (book: ReturnType<ReadingService['pdfPage']>): BookReference => {
  const chapter = book.chapters[0]!, first = chapter.paragraphs[0]!, last = chapter.paragraphs.at(-1)!;
  const start = { chapterId: chapter.id, paragraphId: first.id, offset: 0 }, end = { chapterId: chapter.id, paragraphId: last.id, offset: last.text.length };
  return { bookId: book.id, version: book.version, start, end, text: referenceText(book, start, end) };
};

test('原页正文覆盖跨块长页，但不包含同块的相邻章节；历史记录及版本不变', async () => {
  const h = await setup();
  try {
    const source = textPdf(['a'.repeat(70000), 'Second page.'], 0, [], .005);
    const book = await h.service.import({ commandId: 'pdf', title: '原页', author: '', format: 'pdf', dataBase64: source.toString('base64') });
    const old = reference(h.service.pdfPage(book.id, 2));
    h.service.annotate(book.id, { commandId: 'old-mark', id: 'mark', expectedRevision: 0, action: 'save', kind: 'highlight', reference: old });
    const records = h.service.annotations(book.id);
    h.store.reading.content.full = () => { throw new Error('不能读取整书'); };
    const first = h.service.pdfPage(book.id, 1);
    assert.equal(first.chapters.length, 1);
    assert.equal(first.chapters[0]!.paragraphs.map(p => p.text).join('').length, 70000);
    assert.ok(!JSON.stringify(first.chapters).includes('Second page.'));
    assert.equal(first.version, book.version);
    assert.deepEqual(h.service.annotations(book.id), records);
    assert.ok(h.store.reading.content.validReference(book.id, old));
    assert.throws(() => h.service.pdfPage(book.id, 0)); assert.throws(() => h.service.pdfPage(book.id, 3));
  } finally { await h.close(); }
});

test('书伴完整原页快照拒绝跨页与局部范围，扫描页不提供伪造文本', async () => {
  const h = await setup();
  try {
    const source = textPdf(['Page one.', 'Page two.', '']);
    const book = await h.service.import({ commandId: 'pdf', title: '书伴', author: '', format: 'pdf', dataBase64: source.toString('base64') });
    const discussion = h.service.ensureCompanion(book.id);
    const first = reference(h.service.pdfPage(book.id, 1)), second = reference(h.service.pdfPage(book.id, 2));
    const context = await h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: first, pageReference: first, referenceKind: 'current-page', adjacentPages: { previous: null, next: { start: second.start, end: second.end } } }]);
    assert.equal(context.kind, 'reading'); if (context.kind !== 'reading') throw new Error('上下文缺失');
    assert.deepEqual(context.currentPage, first);
    assert.ok(!JSON.stringify(context.currentPage).includes(second.text));
    assert.deepEqual(h.service.readAdjacentPage(discussion.sessionId, context.pageTools!.contextId, 'next').reference, second);
    const partial = { ...first, end: { ...first.end, offset: 4 }, text: 'Page' };
    await assert.rejects(h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: partial, pageReference: partial, referenceKind: 'current-page' }]), /完整原始页/u);
    const both = { ...first, end: second.end, text: `${first.text}\n${second.text}` };
    await assert.rejects(h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: both, pageReference: both, referenceKind: 'current-page' }]), /完整原始页/u);
    const scan = reference(h.service.pdfPage(book.id, 3));
    assert.throws(() => h.service.context(discussion.sessionId, scan), /OCR/u);
    await assert.rejects(h.service.contextForRefs(discussion.sessionId, [{ kind: 'book', reference: first, pageReference: scan, referenceKind: 'selection' }]), /OCR/u);
    h.service.annotate(book.id, { commandId: 'scan-bookmark', id: 'scan-mark', expectedRevision: 0, action: 'save', kind: 'bookmark', reference: scan });
    assert.equal(h.service.annotations(book.id)[0]!.reference.start.chapterId, 'c3');
  } finally { await h.close(); }
});

test('原文件接口支持 HEAD、206、416；原文件缺失保留历史书签', async () => {
  const h = await setup();
  const server = createServer((request, response) => { void createReadingRequestHandler(h.service)(request, response); });
  try {
    const source = textPdf();
    const book = await h.service.import({ commandId: 'pdf', title: '范围读取', author: '', format: 'pdf', dataBase64: source.toString('base64') });
    const ref = reference(h.service.pdfPage(book.id, 1));
    h.service.annotate(book.id, { commandId: 'bookmark', id: 'bookmark', expectedRevision: 0, action: 'save', kind: 'bookmark', reference: ref });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/api/reading/books/${book.id}/pdf/source`;
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), source.length);
    const partial = await fetch(url, { headers: { range: 'bytes=0-7' } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get('content-range'), `bytes 0-7/${source.length}`);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), source.subarray(0, 8));
    const invalid = await fetch(url, { headers: { range: `bytes=${source.length}-` } });
    assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), `bytes */${source.length}`);
    await rm(h.service.pdfSource(book.id));
    const missing = await fetch(url); assert.equal(missing.status, 404);
    assert.match(await missing.text(), /历史记录仍保留/u);
    assert.equal(h.service.annotations(book.id).length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await h.close(); }
});
