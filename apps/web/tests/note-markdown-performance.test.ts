import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState } from '@tiptap/pm/state';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown, updateNoteMarkdown, noteMarkdownSelection } from '../src/features/notes/note-markdown.js';

const schema = getSchema(noteRichTextExtensions);
const manager = new MarkdownManager({ extensions: noteRichTextExtensions });
const parse = (source: string) => parseNoteMarkdown(source, schema);
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => manager.serialize(content);

test('长纯文本段局部插删复用直接映射，原文与引用等同完整解析', () => {
  let current = parse('普通文字🙂，'.repeat(12000) + '\n\n末段保留。');
  assert.equal(current.blocks[0]!.linearText, true);
  assert.equal(current.blocks[0]!.characters.size, 0);
  for (const [from, to, text] of [[3, 3, '新增'], [4, 6, '替换文字'], [2, 4, ''], [1, 1, '开头']] as const) {
    const previous = current;
    const transaction = EditorState.create({ doc: previous.doc }).tr.insertText(text, from, to);
    current = updateNoteMarkdown(previous, transaction.doc, serialize);
    assert.equal(current.blocks[0]!.characters, previous.blocks[0]!.characters, '安全编辑不重建段落映射');
    assert.equal(current.blocks[1]!.characters, previous.blocks[1]!.characters);
    const full = parse(current.source);
    assert.ok(full.doc.eq(transaction.doc));
    for (const position of [1, 3, 30, transaction.doc.content.size - 4]) {
      assert.deepEqual(noteMarkdownSelection(current, position, position + 2), noteMarkdownSelection(full, position, position + 2));
    }
  }
});

test('直接映射段与格式、转义和实体段混合时，后续字符索引不偏移', () => {
  const source = '普通文字🙂\n\n**粗体** 与 \\*文字 &amp;\n\n末段。';
  const current = parse(source);
  let entity = 0;
  current.doc.descendants((node, position) => { if (node.isText && node.text?.includes('&')) entity = position + node.text.indexOf('&'); });
  assert.equal(noteMarkdownSelection(current, entity, entity + 1)?.text, '&amp;');
  const changed = EditorState.create({ doc: current.doc }).tr.insertText('新增', 2);
  const updated = updateNoteMarkdown(current, changed.doc, serialize);
  assert.equal(noteMarkdownSelection(updated, entity + 2, entity + 3)?.text, '&amp;');
});

test('段首结构符号、首尾空白、格式命令和清空仍正确回退', () => {
  for (const text of ['# ', '> ', '- ', '1. ', '    ', '*', '&amp;']) {
    const original = parse('普通文字');
    const changed = EditorState.create({ doc: original.doc }).tr.insertText(text, 1);
    const updated = updateNoteMarkdown(original, changed.doc, serialize);
    assert.ok(parse(updated.source).doc.eq(changed.doc), text);
    assert.notEqual(updated.blocks[0]!.characters, original.blocks[0]!.characters);
  }
  const original = parse('普通文字');
  for (const transaction of [
    EditorState.create({ doc: original.doc }).tr.insertText(' ', 5),
    EditorState.create({ doc: original.doc }).tr.addMark(1, 3, schema.marks.bold!.create()),
    EditorState.create({ doc: original.doc }).tr.delete(1, 5),
    EditorState.create({ doc: original.doc }).tr.split(3),
  ]) {
    const updated = updateNoteMarkdown(original, transaction.doc, serialize);
    assert.ok(parse(updated.source).doc.eq(transaction.doc));
  }
});
