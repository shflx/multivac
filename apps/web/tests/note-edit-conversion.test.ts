import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema, type Command } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, redo, closeHistory } from '@tiptap/pm/history';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { toggleNoteTextMark } from '../src/features/notes/note-text-formatting.js';
import { parseNoteMarkdown, updateNoteMarkdown, noteMarkdownSelection } from '../src/features/notes/note-markdown.js';

const schema = getSchema(noteRichTextExtensions);
const manager = new MarkdownManager({ extensions: noteRichTextExtensions });
const parse = (source: string) => parseNoteMarkdown(source, schema);
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => manager.serialize(content);

test('段尾、段首、空段落及连续软换行均能往返并继续输入', () => {
  for (const content of [
    [schema.text('段尾'), schema.node('hardBreak')],
    [schema.node('hardBreak')],
    [schema.node('hardBreak'), schema.node('hardBreak')],
    [schema.node('hardBreak'), schema.text('段首')],
    [schema.text('前'), schema.node('hardBreak'), schema.text('后')],
  ]) {
    const original = parse('原正文\n\n\n末段 **保持**。 \n');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, content), original.doc.lastChild!]);
    const saved = updateNoteMarkdown(original, doc, serialize);
    assert.ok(parse(saved.source).doc.eq(doc), saved.source);
    assert.ok(saved.source.endsWith('\n\n\n末段 **保持**。 \n'));
    const typed = EditorState.create({ doc }).tr.insertText('继续', doc.firstChild!.nodeSize - 1);
    const next = updateNoteMarkdown(saved, typed.doc, serialize);
    assert.ok(parse(next.source).doc.eq(typed.doc), next.source);
    const restored = updateNoteMarkdown(next, doc, serialize);
    assert.ok(parse(restored.source).doc.eq(doc));
    let last = 0;
    next.doc.descendants((node, position) => { if (node.text === '保持') last = position; });
    assert.equal(noteMarkdownSelection(next, last, last + 2)?.text, '保持');
    assert.equal(next.blocks[1]!.characters, original.blocks[1]!.characters);
  }
});

test('显式换行只识别无属性标签，其他 HTML 原文保持受保护', () => {
  for (const source of ['<br />', '<br /><br />', '文字<br />', '> 文字<br />', '- 文字<br />', '## 文字<br />']) {
    const parsed = parse(source);
    let breaks = 0; parsed.doc.descendants(node => { if (node.type.name === 'hardBreak') breaks++; });
    assert.equal(breaks, source === '<br /><br />' ? 2 : 1);
    parsed.doc.check();
  }
  for (const source of ['<br onclick="alert(1)">', '<script>alert(1)</script>']) {
    const parsed = parse(source);
    assert.equal(parsed.doc.firstChild?.type.name, 'noteRawBlock');
    assert.equal(updateNoteMarkdown(parsed, parsed.doc, serialize).source, source);
  }
});

test('首尾含空白的选区加粗或斜体保留文字、选区和段落原文，支持撤销重做', () => {
  for (const name of ['bold', 'italic'] as const) {
    for (const text of ['  选中文字  ', '  选中文字', '选中文字  ', '   ']) {
      const original = parse(`开头${text}结尾\n\n\n末段 **保持**。 \n`);
      let markdown = original;
      let state = EditorState.create({ doc: original.doc, selection: TextSelection.create(original.doc, 3, 3 + text.length), plugins: [history()] });
      const dispatch = (tr: Parameters<NonNullable<Parameters<typeof undo>[1]>>[0]) => {
        const next = updateNoteMarkdown(markdown, tr.doc, serialize);
        state = state.apply(tr); markdown = next;
      };
      assert.ok(toggleNoteTextMark(name)({ state, dispatch } as Parameters<Command>[0]));
      assert.equal(state.selection.from, 3); assert.equal(state.selection.to, 3 + text.length);
      assert.equal(state.doc.textContent, original.doc.textContent);
      assert.ok(parse(markdown.source).doc.eq(state.doc));
      assert.ok(markdown.source.endsWith('\n\n\n末段 **保持**。 \n'));
      const marked: string[] = [];
      state.doc.firstChild!.descendants(node => {
        if (node.isText && node.marks.some(mark => mark.type.name === name)) marked.push(node.text!);
      });
      assert.deepEqual(marked, text.trim() ? ['选中文字'] : []);
      assert.equal(noteMarkdownSelection(markdown, 3, 3 + text.length)?.text.replace(/\*+/g, ''), text);
      if (text.trim()) {
        const formatted = state.doc;
        assert.ok(undo(state, dispatch)); assert.ok(state.doc.eq(original.doc));
        assert.ok(redo(state, dispatch)); assert.ok(state.doc.eq(formatted));
      }
      dispatch(closeHistory(state.tr).insertText('继续', state.selection.to));
      assert.ok(parse(markdown.source).doc.eq(state.doc));
      assert.ok(state.doc.textContent.includes('继续'));
    }
  }
});

test('软换行的真实历史事务可撤销重做，保存回读结构相等', () => {
  let markdown = parse('段尾');
  let state = EditorState.create({ doc: markdown.doc, plugins: [history()] });
  const dispatch = (tr: Parameters<NonNullable<Parameters<typeof undo>[1]>>[0]) => {
    markdown = updateNoteMarkdown(markdown, tr.doc, serialize); state = state.apply(tr);
    assert.ok(parse(markdown.source).doc.eq(state.doc));
  };
  dispatch(state.tr.insert(state.doc.content.size - 1, schema.node('hardBreak')));
  assert.ok(undo(state, dispatch)); assert.equal(markdown.source, '段尾');
  assert.ok(redo(state, dispatch)); assert.equal(markdown.source, '段尾<br />');
});

test('不可无损表示的结构仍拒绝，既有原文及映射不变', () => {
  const original = parse('保留的正文\n\n末段');
  const snapshot = original.doc.toJSON();
  const invalid = schema.node('doc', null, [schema.node('paragraph', null, schema.node('noteRawInline', { source: '**损坏' }))]);
  assert.throws(() => updateNoteMarkdown(original, invalid, serialize), /不能无损/);
  assert.equal(original.source, '保留的正文\n\n末段');
  assert.deepEqual(original.doc.toJSON(), snapshot);
  assert.equal(noteMarkdownSelection(original, 1, 3)?.text, '保留');
});
