import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown } from '../src/features/notes/note-markdown.js';
import { noteBlocks } from '../src/features/notes/note-blocks.js';
import { noteBlockPreview, reconcileNoteBlockFolds } from '../src/features/notes/note-block-folding.js';
const schema = getSchema(noteRichTextExtensions);
const doc = (source: string) => parseNoteMarkdown(source, schema).doc;

test('首行预览与剩余逻辑行数，偏好键不包含正文', () => {
  const block = noteBlocks(doc('首行\n第二行\n\n第三段\n\n---\n\n后块'))[0]!;
  const preview = noteBlockPreview(block);
  assert.equal(preview.first, '首行'); assert.equal(preview.remaining, 2);
  assert.match(preview.key, /^0:[\da-f]+$/);
});
test('首行编辑或块序号变化时原指纹失效，指纹匹配时保留折叠', () => {
  const initial = doc('甲\n\n---\n\n乙');
  const folded = new Set([noteBlockPreview(noteBlocks(initial)[1]!).key]);
  assert.equal(reconcileNoteBlockFolds(folded, initial), folded);
  assert.equal(reconcileNoteBlockFolds(folded, doc('甲\n\n---\n\n已改乙')).size, 0);
  assert.equal(reconcileNoteBlockFolds(folded, doc('乙\n\n---\n\n甲')).size, 0);
});
test('光标和跨块选区进入折叠块时展开，块外选区不展开', () => {
  const initial = doc('甲\n\n---\n\n乙'); const blocks = noteBlocks(initial);
  const folded = new Set([noteBlockPreview(blocks[1]!).key]);
  assert.equal(reconcileNoteBlockFolds(folded, initial, TextSelection.create(initial, 1)).size, 1);
  assert.equal(reconcileNoteBlockFolds(folded, initial, TextSelection.create(initial, blocks[1]!.from + 1)).size, 0);
  assert.equal(reconcileNoteBlockFolds(folded, initial, TextSelection.create(initial, 1, blocks[1]!.to - 1)).size, 0);
});
