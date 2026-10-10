import test from 'node:test';
import assert from 'node:assert/strict';
import { Check } from 'typebox/value';
import { BookSchema, BookReferenceSchema, BookLocationSchema, bookLocation, referenceText, validBookReference, type Book } from '../src/reading.js';

const book: Book = { id: 'book', version: 'v1', title: '图文', author: '', format: 'epub', createdAt: '', paragraphCount: 4, chapters: [{ id: 'c1', title: '一章', paragraphs: [
  { id: 'c1:p1', text: '前文😀 后文', images: [{ id: 'c1:image1', offset: 5, alt: '行内图', width: 100, height: 50, resourceId: 'a'.repeat(64) }] },
  { id: 'c1:i2', text: '', images: [{ id: 'c1:image2', offset: 0, alt: '整页图表', width: 100, height: 200 }] },
  { id: 'c1:p2', text: '下一段' },
  { id: 'c1:i3', text: '', images: [{ id: 'c1:image3', offset: 0, alt: '后页图片', width: 100, height: 200 }] },
] }] };
const position = (paragraphId: string, offset: number) => ({ chapterId: 'c1', paragraphId, offset });

test('图文契约接受纯图片锚点，文字引用跨图保持原摘录和端点换行', () => {
  assert.ok(Check(BookSchema, book));
  const start = position('c1:p1', 0), end = position('c1:p2', 3);
  const text = '前文😀 后文\n下一段';
  assert.equal(referenceText(book, start, end), text);
  assert.ok(validBookReference(book, { bookId: book.id, version: book.version, start, end, text }));
  assert.equal(referenceText(book, start, position('c1:p2', 0)), '前文😀 后文\n');
});

test('当前图片页可使用零文字范围，只引用实际指定插图并保留定位提示', () => {
  const start = position('c1:i2', 0), imageIds = ['c1:image2'];
  const text = referenceText(book, start, start, imageIds);
  const reference = { bookId: book.id, version: book.version, start, end: start, text, imageIds };
  assert.ok(Check(BookReferenceSchema, reference)); assert.ok(validBookReference(book, reference));
  assert.match(text, /整页图表.*不能理解图像内容/);
  assert.doesNotMatch(text, /下一段|后页图片|前文/);
  const location = bookLocation(reference);
  assert.ok(Check(BookLocationSchema, location)); assert.equal(location.imageId, 'c1:image2');
  assert.deepEqual(bookLocation({ bookId: book.id, version: book.version, start: position('c1:p2', 0), end: position('c1:p2', 3), text: '下一段' }), { bookId: book.id, version: book.version, position: position('c1:p2', 0) });
});

test('行内图片描述插在正确 UTF-16 偏移，拒绝引用范围外图片与代理对中间端点', () => {
  const start = position('c1:p1', 5), end = position('c1:p1', 7), imageIds = ['c1:image1'];
  assert.equal(referenceText(book, start, end, imageIds), '[图片：行内图；当前书伴仅接收图片说明，不能理解图像内容]后文');
  assert.equal(referenceText(book, start, end, ['c1:image3']), '');
  assert.equal(referenceText(book, start, end, ['unknown']), '');
  assert.equal(referenceText(book, position('c1:p1', 3), end, imageIds), '');
});
