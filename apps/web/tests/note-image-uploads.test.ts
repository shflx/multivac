import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema, type Editor } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { NoteImageUploads } from '../src/features/notes/note-image-uploads.js';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { noteUploadCount, noteUploadPosition } from '../src/features/notes/note-image-editing.js';
import { parseNoteMarkdown } from '../src/features/notes/note-markdown.js';

const schema = getSchema(noteRichTextExtensions);
function host() {
  let state = EditorState.create({ doc: parseNoteMarkdown('正文', schema).doc });
  const editor = { schema, get state() { return state; }, view: { dispatch(transaction: Parameters<typeof state.apply>[0]) { state = state.apply(transaction); } } } as unknown as Editor;
  return editor;
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function replies() {
  const original = globalThis.fetch;
  const pending: { url: string; signal: AbortSignal; reply(value: Response): void }[] = [];
  globalThis.fetch = (async (url, input) => new Promise<Response>(reply => { pending.push({ url: String(url), signal: input!.signal as AbortSignal, reply }); })) as typeof fetch;
  return { pending, restore: () => { globalThis.fetch = original; } };
}
const success = (noteId: string, id: string) => new Response(JSON.stringify({ id, noteId }), { status: 200 });
const file = (name: string) => new File(['bytes'], name, { type: 'image/png' });

test('真实上传控制器保留继续输入；多图独立失败，删除后迟到成功不补插', async () => {
  const network = replies(), editor = host();
  const uploads = new NoteImageUploads('a', () => true, () => {}, () => {}); uploads.attach(editor);
  try {
    uploads.insert([file('one.png'), file('two.png')], 2);
    assert.equal(noteUploadCount(editor.state.doc), 2);
    assert.equal(network.pending.length, 1);
    editor.view.dispatch(editor.state.tr.insertText('继续', 1));
    network.pending[0]!.reply(success('a', 'a'.repeat(64))); await flush();
    assert.equal(network.pending.length, 2);
    assert.equal(editor.state.doc.nodeAt(4)?.type.name, 'noteImage');
    network.pending[1]!.reply(new Response(JSON.stringify({ error: { message: '上传失败' } }), { status: 500 })); await flush();
    assert.equal(noteUploadCount(editor.state.doc), 1);
    assert.equal(editor.state.doc.textContent, '继续正文');
    uploads.insert([file('late.png')], 1);
    const id = editor.state.doc.nodeAt(1)!.attrs.id as string;
    const position = noteUploadPosition(editor.state.doc, id)!;
    editor.view.dispatch(editor.state.tr.delete(position, position + 1));
    network.pending[2]!.reply(success('a', 'b'.repeat(64))); await flush();
    assert.equal(noteUploadPosition(editor.state.doc, id), null);
    assert.equal(editor.state.doc.textContent, '继续正文');
    const sources: string[] = []; editor.state.doc.descendants(node => { if (node.type.name === 'noteImage') sources.push(String(node.attrs.src)); });
    assert.deepEqual(sources, [`note-image:${'a'.repeat(64)}`]);
  } finally { uploads.dispose(); network.restore(); }
});

test('不同笔记拥有独立账本；卸载中断请求，迟到响应不能写入另一篇', async () => {
  const network = replies(), a = host(), b = host();
  const first = new NoteImageUploads('a', () => true, () => {}, () => {}), second = new NoteImageUploads('b', () => true, () => {}, () => {});
  first.attach(a); second.attach(b);
  try {
    first.insert([file('a.png')], 2); second.insert([file('b.png')], 2);
    assert.equal(network.pending[0]!.url, '/api/notes/a/images');
    assert.equal(network.pending[1]!.url, '/api/notes/b/images');
    first.dispose(); assert.equal(network.pending[0]!.signal.aborted, true);
    network.pending[0]!.reply(success('a', 'a'.repeat(64))); network.pending[1]!.reply(success('b', 'b'.repeat(64))); await flush();
    assert.equal(a.state.doc.nodeAt(2)?.type.name, 'noteImageUpload');
    assert.equal(b.state.doc.nodeAt(2)?.attrs.src, `note-image:${'b'.repeat(64)}`);
  } finally { first.dispose(); second.dispose(); network.restore(); }
});
