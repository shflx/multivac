import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown } from '../src/features/notes/note-markdown.js';
import { noteBlocks, noteBlocksKey, loadNoteBlocks, clearNoteBlocks } from '../src/features/notes/note-blocks.js';

const schema = getSchema(noteRichTextExtensions);
test('顶层 n 条分隔线产生 n+1 块，开头、末尾与连续分隔线保留空块', () => {
  const doc = parseNoteMarkdown('---\n\n甲\n\n---\n\n---\n', schema).doc;
  const blocks = noteBlocks(doc);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks.map(block => block.nodes.map(({ node }) => node.textContent).join('')), ['', '甲', '', '']);
  assert.deepEqual(blocks.map(block => [block.from, block.to]), [[0, 0], [1, 4], [5, 5], [6, 6]]);
  assert.equal(noteBlocks(parseNoteMarkdown('', schema).doc).length, 1);
});
test('引用和列表的嵌套分隔线不参与分块，代码围栏内的 --- 仍是文字', () => {
  const doc = parseNoteMarkdown('> 甲\n>\n> ---\n\n- 乙\n\n  ---\n\n```\n---\n```\n\n---\n\n丙', schema).doc;
  assert.equal(noteBlocks(doc).length, 2);
  assert.equal(noteBlocks(doc)[0]!.nodes.length, 3);
});
test('本机模式按笔记隔离并在删除时清理', () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) } });
  try {
    values.set(noteBlocksKey('a'), 'true'); values.set(noteBlocksKey('b'), 'false');
    assert.equal(loadNoteBlocks('a'), true); assert.equal(loadNoteBlocks('b'), false);
    clearNoteBlocks('a'); assert.equal(loadNoteBlocks('a'), false); assert.equal(values.get(noteBlocksKey('b')), 'false');
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
