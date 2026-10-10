import test from 'node:test';
import assert from 'node:assert/strict';
import type { Book } from '@multivac/contracts';
import { restoreReadingScene } from '../src/features/reading/reading-scene.js';

const book: Book = { id: 'book-pdf', version: 'v1', title: '原页', author: '', format: 'pdf', createdAt: '', paragraphCount: 2, chapters: [
  { id: 'c1', title: '第 1 页', paragraphs: [{ id: 'c1:p1', text: 'First.' }] },
  { id: 'c2', title: '第 2 页', paragraphs: [{ id: 'c2:p1', text: 'Second.' }] },
] };

test('历史文字位置原样恢复，缺少原页字段时采用默认缩放而不重写引用', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ version: 'v1', position: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 3 }, fontSize: 22 }) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  const scene = restoreReadingScene(book);
  assert.deepEqual(scene.position, { chapterId: 'c2', paragraphId: 'c2:p1', offset: 3 });
  assert.equal(scene.pdfPage, null); assert.equal(scene.pdfZoom, 1); assert.equal(scene.fontSize, 22);
  assert.deepEqual(scene.pdfScroll, { x: 0, y: 0 });
});

test('原页编号、缩放与相对滚动刷新恢复；坏数据和旧版本保留安全默认值', t => {
  let value: unknown = { version: 'v1', position: { chapterId: 'c2', paragraphId: 'c2:p1', offset: 0 }, pdfPage: 2, pdfZoom: 2, pdfScroll: { x: .2, y: .4 } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify(value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  let scene = restoreReadingScene(book);
  assert.equal(scene.pdfPage, 2); assert.equal(scene.pdfZoom, 2); assert.deepEqual(scene.pdfScroll, { x: .2, y: .4 });
  value = { version: 'v1', pdfPage: -1, pdfZoom: 100, pdfScroll: { x: -1, y: 10 } };
  scene = restoreReadingScene(book); assert.equal(scene.pdfPage, null); assert.equal(scene.pdfZoom, 3); assert.deepEqual(scene.pdfScroll, { x: 0, y: 1 });
  value = { version: 'old', pdfPage: 2, pdfZoom: 2 };
  scene = restoreReadingScene(book); assert.equal(scene.pdfPage, null); assert.equal(scene.pdfZoom, 1);
});
