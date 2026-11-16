import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { history, undo, redo, closeHistory } from '@tiptap/pm/history';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown } from '../src/features/notes/note-markdown.js';
import { prepareNoteEdit } from '../src/features/notes/note-edit-protection.js';
import { noteBlockTransaction, type NoteBlockAction } from '../src/features/notes/note-block-commands.js';
import { noteBlockTransactionSource } from '../src/features/notes/note-block-source-step.js';
import { noteBlocks } from '../src/features/notes/note-blocks.js';

const schema = getSchema(noteRichTextExtensions);
const manager = new MarkdownManager({ extensions: noteRichTextExtensions });
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => manager.serialize(content);
const original = '首块 **保留**。 \n\n---\n\n第二块 _保持_  \n换行\n\n***\n\n末块 `代码`。 \n';
function setup(source = original) {
  let markdown = parseNoteMarkdown(source, schema);
  let state = EditorState.create({ doc: markdown.doc, plugins: [history()] });
  const apply = (tr: Transaction) => {
    if (tr.docChanged) {
      const candidate = noteBlockTransactionSource(tr);
      if (candidate) assert.ok(candidate.doc.eq(tr.doc), '原文步骤须与最终文档一致');
      const result = prepareNoteEdit(markdown, tr.doc, serialize, candidate);
      assert.ok(result.ok, result.ok ? '' : result.error.message);
      if (result.ok) markdown = result.markdown;
    }
    state = state.apply(tr);
  };
  return { get state() { return state; }, get markdown() { return markdown; }, apply };
}
for (const action of ['insert', 'split', 'merge', 'up', 'down', 'copy', 'delete'] satisfies NoteBlockAction[]) {
  test(`${action} 通过转换保护，一次撤销恢复原文，一次重做恢复结果`, () => {
    const ctx = setup(); const block = noteBlocks(ctx.state.doc)[1]!;
    ctx.apply(ctx.state.tr.setSelection(TextSelection.create(ctx.state.doc, block.from + 3)));
    const tr = noteBlockTransaction(ctx.state, ctx.markdown, action, 1, serialize);
    assert.ok(tr, '块命令应生成事务'); ctx.apply(tr);
    const changed = ctx.markdown.source;
    assert.notEqual(changed, original);
    assert.ok(changed.includes('首块 **保留**。 \n'));
    assert.ok(changed.includes('末块 `代码`。 \n'));
    assert.ok(parseNoteMarkdown(changed, schema).doc.eq(ctx.state.doc));
    ctx.apply(closeHistory(ctx.state.tr).setMeta('addToHistory', false));
    assert.ok(undo(ctx.state, ctx.apply)); assert.equal(ctx.markdown.source, original);
    assert.ok(redo(ctx.state, ctx.apply)); assert.equal(ctx.markdown.source, changed);
  });
}
test('第 3 块移动到第 1 块前，内容和其他块原文保留', () => {
  const ctx = setup(); const tr = noteBlockTransaction(ctx.state, ctx.markdown, 'move', 2, serialize, 0)!;
  ctx.apply(tr);
  assert.deepEqual(noteBlocks(ctx.state.doc).map(block => block.nodes.map(({ node }) => node.textContent).join('')), ['末块 代码。', '首块 保留。', '第二块 保持换行']);
  assert.ok(ctx.markdown.source.includes('第二块 _保持_  \n换行'));
  assert.ok(undo(ctx.state, ctx.apply)); assert.equal(ctx.markdown.source, original);
});
test('单块删除清空内容，边界空块也可复制、移动和删除', () => {
  const single = setup('正文'); single.apply(noteBlockTransaction(single.state, single.markdown, 'delete', 0, serialize)!);
  assert.equal(single.markdown.source, ''); assert.equal(noteBlocks(single.state.doc).length, 1);
  for (const action of ['copy', 'up', 'delete'] as const) {
    const ctx = setup('---\n\n甲\n\n---');
    const tr = noteBlockTransaction(ctx.state, ctx.markdown, action, 2, serialize); assert.ok(tr); ctx.apply(tr);
    assert.ok(undo(ctx.state, ctx.apply)); assert.equal(ctx.markdown.source, '---\n\n甲\n\n---');
  }
});
test('块事务仍受正文长度限制，上传占位存在时暂停整理', () => {
  const ctx = setup('a'.repeat(60000));
  const tr = noteBlockTransaction(ctx.state, ctx.markdown, 'copy', 0, serialize)!;
  const result = prepareNoteEdit(ctx.markdown, tr.doc, serialize, noteBlockTransactionSource(tr));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, 'limit');
  const upload = ctx.state.apply(ctx.state.tr.insert(2, schema.nodes.noteImageUpload!.create({ id: 'job' })));
  assert.equal(noteBlockTransaction(upload, ctx.markdown, 'delete', 0, serialize), null);
});

test('空块激活一次撤销还原原文；相同节点的不同 Markdown 仍能移动及撤销', () => {
  const empty = setup('---\n\n甲');
  empty.apply(noteBlockTransaction(empty.state, empty.markdown, 'activate', 0, serialize)!);
  assert.equal(noteBlocks(empty.state.doc)[0]!.nodes[0]!.node.type.name, 'paragraph');
  assert.ok(undo(empty.state, empty.apply)); assert.equal(empty.markdown.source, '---\n\n甲');
  const same = setup('**同文**\n\n---\n\n__同文__');
  same.apply(noteBlockTransaction(same.state, same.markdown, 'up', 1, serialize)!);
  assert.ok(same.markdown.source.indexOf('__同文__') < same.markdown.source.indexOf('**同文**'));
  assert.ok(undo(same.state, same.apply)); assert.equal(same.markdown.source, '**同文**\n\n---\n\n__同文__');
  const whitespace = setup(' \n\n');
  whitespace.apply(noteBlockTransaction(whitespace.state, whitespace.markdown, 'delete', 0, serialize)!);
  assert.equal(whitespace.markdown.source, '');
});
test('未闭合围栏吞掉目标边界时拒绝操作，保留原文', () => {
  for (const [source, action, index] of [['甲\n\n---\n\n```\n代码', 'up', 1], ['甲\n\n---\n\n```\n代码', 'down', 0], ['```\n代码', 'insert', 0]] as const) {
    const ctx = setup(source);
    assert.throws(() => noteBlockTransaction(ctx.state, ctx.markdown, action, index, serialize), /无损/);
    assert.equal(ctx.markdown.source, source);
  }
});

test('合并相邻列表沿用普通 Markdown 语义，其余块原文不变', () => {
  const original = '- 甲\n\n---\n\n- 乙\n\n---\n\n末块 _原文_。 \n';
  const ctx = setup(original);
  ctx.apply(noteBlockTransaction(ctx.state, ctx.markdown, 'merge', 1, serialize)!);
  assert.equal(noteBlocks(ctx.state.doc).length, 2);
  assert.equal(ctx.state.doc.firstChild!.type.name, 'bulletList');
  assert.equal(ctx.state.doc.firstChild!.childCount, 2);
  assert.ok(ctx.markdown.source.endsWith('末块 _原文_。 \n'));
  assert.ok(undo(ctx.state, ctx.apply)); assert.equal(ctx.markdown.source, original);
});
