import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown } from '../src/features/notes/note-markdown.js';
import { prepareNoteEdit, noteEditorErrors, type NoteEditorErrors } from '../src/features/notes/note-edit-protection.js';

const schema = getSchema(noteRichTextExtensions);

// 使用真实 Tiptap 命令，但不挂载 DOM；此测试不能替代浏览器编辑和焦点验证。
test('Tiptap 注册的格式及软换行命令经过转换保护仍可连续编辑与撤销重做', () => {
  for (const mark of ['bold', 'italic'] as const) {
    let markdown = parseNoteMarkdown('前  选中文字  后\n\n\n末段 **保持**。 \n', schema);
    let errors: NoteEditorErrors = { editing: { kind: 'conversion', message: '旧转换错误' }, save: '原保存错误' };
    const editor = new Editor({ element: null, extensions: noteRichTextExtensions, content: markdown.doc.toJSON(), onUpdate({ editor }) {
      const result = prepareNoteEdit(markdown, editor.state.doc, content => editor.markdown!.serialize(content));
      assert.equal(result.ok, true);
      if (result.ok) markdown = result.markdown;
      errors = noteEditorErrors(errors, { type: 'edit-accepted' });
      assert.ok(parseNoteMarkdown(markdown.source, editor.schema).doc.eq(editor.state.doc));
    } });
    markdown = parseNoteMarkdown(markdown.source, editor.schema);
    editor.registerPlugin(history());
    try {
      editor.commands.setTextSelection({ from: 2, to: 10 });
      assert.ok(mark === 'bold' ? editor.commands.toggleBold() : editor.commands.toggleItalic());
      assert.equal(editor.state.selection.from, 2); assert.equal(editor.state.selection.to, 10);
      assert.equal(errors.editing, null); assert.equal(errors.save, '原保存错误');
      const formatted = editor.state.doc;
      assert.ok(editor.commands.undo()); assert.equal(markdown.source, '前  选中文字  后\n\n\n末段 **保持**。 \n');
      assert.ok(editor.commands.redo()); assert.ok(editor.state.doc.eq(formatted));
      // 在有格式的文字后加入换行；原格式和后续输入均保留。
      editor.commands.setTextSelection(8);
      assert.ok(editor.commands.setHardBreak());
      editor.commands.command(({ tr }) => { tr.insertText('继续'); return true; });
      assert.ok(editor.state.doc.textContent.includes('继续'));
      assert.ok(markdown.source.includes('<br />'));
      assert.ok(markdown.source.endsWith('\n\n\n末段 **保持**。 \n'));
    } finally { editor.destroy(); }
  }
});
