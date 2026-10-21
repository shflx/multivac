import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, redo, closeHistory } from '@tiptap/pm/history';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { noteUploadCount, noteWithoutUploads, noteUploadPosition, notePositionWithoutUploads, resolveNoteUpload } from '../src/features/notes/note-image-editing.js';
import { parseNoteMarkdown, updateNoteMarkdown } from '../src/features/notes/note-markdown.js';
import { noteImageId, noteImageContentUrl, noteImageReferences } from '@multivac/contracts';

const schema = getSchema(noteRichTextExtensions);
const markdown = new MarkdownManager({ extensions: noteRichTextExtensions });
const imageId = 'a'.repeat(64);
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => markdown.serialize(content);
const upload = (id: string) => schema.nodes.noteImageUpload!.create({ id, alt: '截图' });

test('上传占位不进入 Markdown；输入、移动光标后仍在原占位替换，邻接格式和稳定引用往返', () => {
  const original = parseNoteMarkdown('**之前**与之后', schema);
  let state = EditorState.create({ doc: original.doc });
  state = state.apply(state.tr.insert(3, upload('job')));
  assert.equal(noteUploadCount(state.doc), 1);
  assert.ok(noteWithoutUploads(state.doc).eq(original.doc));
  assert.equal(updateNoteMarkdown(original, noteWithoutUploads(state.doc), serialize).source, original.source);
  state = state.apply(state.tr.insertText('新增', 1));
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const at = noteUploadPosition(state.doc, 'job')!;
  assert.equal(at, 5);
  assert.equal(notePositionWithoutUploads(state.doc, state.doc.content.size), state.doc.content.size - 1);
  const transaction = state.tr;
  assert.equal(resolveNoteUpload(transaction, 'job', imageId), true);
  state = state.apply(transaction);
  assert.equal(state.doc.nodeAt(at)?.attrs.src, `note-image:${imageId}`);
  const saved = updateNoteMarkdown(original, state.doc, serialize);
  assert.ok(parseNoteMarkdown(saved.source, schema).doc.eq(state.doc));
  assert.deepEqual(noteImageReferences(saved.source), [imageId]);
  assert.equal(/data:|blob:|noteImageUpload|job/u.test(saved.source), false);
});

test('删除占位及切换基线后丢弃迟到结果；多图部分失败互不替换', () => {
  const parsed = parseNoteMarkdown('文字', schema);
  let state = EditorState.create({ doc: parsed.doc });
  state = state.apply(state.tr.insert(2, [upload('first'), upload('second')]));
  state = state.apply(state.tr.delete(2, 3));
  assert.equal(resolveNoteUpload(state.tr, 'first', imageId), false);
  const resolved = state.tr;
  assert.equal(resolveNoteUpload(resolved, 'second', imageId), true);
  state = state.apply(resolved);
  assert.equal(noteUploadCount(state.doc), 0);
  assert.equal(state.doc.textContent, '文字');
  const other = EditorState.create({ doc: parseNoteMarkdown('另一篇', schema).doc });
  assert.equal(resolveNoteUpload(other.tr, 'second', imageId), false);
  assert.equal(other.doc.textContent, '另一篇');
});

test('完成替换不新增撤销步骤；撤销重做保持图片，删除后仍能撤销恢复', () => {
  let state = EditorState.create({ doc: parseNoteMarkdown('前后', schema).doc, plugins: [history()] });
  const apply = (transaction: Parameters<typeof state.apply>[0]) => { state = state.apply(transaction); };
  apply(closeHistory(state.tr).insert(2, upload('job')));
  apply(closeHistory(state.tr).setMeta('addToHistory', false));
  const completed = state.tr; resolveNoteUpload(completed, 'job', imageId); apply(completed);
  assert.equal(undo(state, apply), true);
  assert.equal(state.doc.textContent, '前后');
  assert.equal(state.doc.child(0).childCount, 1);
  assert.equal(redo(state, apply), true);
  // ProseMirror 可重做原占位，上传账本按已知完成结果再次替换。
  if (noteUploadCount(state.doc)) { const tr = state.tr; resolveNoteUpload(tr, 'job', imageId); apply(tr); }
  assert.equal(state.doc.nodeAt(2)?.attrs.src, `note-image:${imageId}`);
  apply(closeHistory(state.tr).delete(2, 3));
  assert.equal(undo(state, apply), true);
  assert.equal(state.doc.nodeAt(2)?.attrs.src, `note-image:${imageId}`);
});

test('来源转换只接受精确的托管协议，外部和宿主地址不成为可加载图片', () => {
  assert.equal(noteImageId(`note-image:${imageId}`), imageId);
  assert.equal(noteImageContentUrl('a:b', `note-image:${imageId}`), `/api/notes/a%3Ab/images/${imageId}/content`);
  for (const source of ['https://example.com/image.png', 'data:image/png;base64,a', 'blob:local', '/Users/a/image.png', `note-image:${imageId}/extra`, 'note-image:bad']) assert.equal(noteImageContentUrl('a', source), null);
  assert.throws(() => noteImageReferences('![x](note-image:bad)'), /引用无效/u);
});
