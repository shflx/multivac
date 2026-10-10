import test from 'node:test';
import assert from 'node:assert/strict';
import { bookFromImport, importFileError, importTitleOf, sortHighlights } from './reading-import.js';
import { makeReference } from './reading-state.js';

test('只接受 PDF、EPUB、TXT、Markdown，文本文件最大 1 MiB', () => {
  assert.equal(importFileError({ name: 'a.docx', size: 10 }), '仅支持 PDF、EPUB、TXT 或 Markdown 文件。');
  assert.equal(importFileError({ name: 'a.txt', size: 2 * 1024 * 1024 }), 'TXT、Markdown 最大 1 MiB，请拆分后再导入。');
  assert.equal(importFileError({ name: 'a.pdf', size: 50 * 1024 * 1024 }), '');
  assert.equal(importFileError({ name: 'a.md', size: 0 }), '文件是空的，请重新选择。');
});

test('书名留空时使用文件名', () => {
  assert.equal(importTitleOf('系统设计笔记.md'), '系统设计笔记');
  assert.equal(importTitleOf('a.md', '  自定义  '), '自定义');
});

test('Markdown 按标题分章、按空行分段，PDF 使用示例正文', () => {
  const book = bookFromImport({ id: 'b', fileName: 'notes.md', title: '', author: '', text: '# 第一章\n第一段\n续行\n\n第二段\n## 第二章\n第三段' });
  assert.equal(book.title, 'notes');
  assert.equal(book.author, '未知作者');
  assert.deepEqual(book.chapters.map((chapter) => [chapter.title, chapter.paragraphs]), [['第一章', ['第一段 续行', '第二段']], ['第二章', ['第三段']]]);
  const pdf = bookFromImport({ id: 'p', fileName: 'scan.pdf', title: '扫描书', author: '作者' });
  assert.equal(pdf.chapters[0].title, '正文（示例）');
  assert.ok(pdf.chapters[0].paragraphs.length > 0);
});

test('划线按原文位置排序，失效位置排在最后', () => {
  const book = bookFromImport({ id: 'b', fileName: 'a.txt', title: '', author: '', text: '甲乙丙丁\n\n戊己庚辛' });
  const [first, second] = book.chapters[0].paragraphs.map((_, index) => `b-c1:p${index + 1}`);
  const late = { id: 'late', reference: makeReference(book, { bookId: 'b', chapterId: 'b-c1', paragraphId: second, offset: 0 }, { bookId: 'b', chapterId: 'b-c1', paragraphId: second, offset: 2 }) };
  const early = { id: 'early', reference: makeReference(book, { bookId: 'b', chapterId: 'b-c1', paragraphId: first, offset: 1 }, { bookId: 'b', chapterId: 'b-c1', paragraphId: first, offset: 3 }) };
  const broken = { id: 'broken', reference: { unavailable: true } };
  assert.deepEqual(sortHighlights(book, [broken, late, early]).map((item) => item.id), ['early', 'late', 'broken']);
});
