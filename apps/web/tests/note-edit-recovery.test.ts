import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { EditorState, Plugin } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { NOTE_BODY_LIMIT, type Note } from '@multivac/contracts';
import { noteRichTextExtensions } from '../src/features/notes/note-rich-text-schema.js';
import { parseNoteMarkdown, type NoteMarkdown } from '../src/features/notes/note-markdown.js';
import { prepareNoteEdit, noteEditorErrors, type NoteEditorErrors } from '../src/features/notes/note-edit-protection.js';
import { NoteEditErrorNotice, NoteSaveErrorNotice } from '../src/features/notes/note-edit-error.js';
import { initialNoteDraft, NoteDraftStorage, noteSaved, noteRefreshed } from '../src/features/notes/note-draft.js';

const schema = getSchema(noteRichTextExtensions);
const manager = new MarkdownManager({ extensions: noteRichTextExtensions });
const serialize = (content: Parameters<MarkdownManager['serialize']>[0]) => manager.serialize(content);
const note: Note = { id: 'a', title: '标题', body: '原正文', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' };

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), snapshot: () => JSON.stringify([...values]) };
}

test('受控转换异常拒绝真实事务，正文及持久草稿不变，合法输入只清除转换错误', t => {
  const local = memoryStorage(), session = memoryStorage();
  // 不读取 Node 的原生 WebStorage getter；测试只使用内存存储。
  const localDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  t.after(() => {
    if (localDescriptor) Object.defineProperty(globalThis, 'localStorage', localDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    if (sessionDescriptor) Object.defineProperty(globalThis, 'sessionStorage', sessionDescriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });
  const storage = new NoteDraftStorage(note.id);
  const request = { commandId: 'original-save', expectedRevision: 1, title: note.title, body: '发送中的正文' };
  let draft = { ...initialNoteDraft(note), pending: request };
  storage.save(draft);
  const before = local.snapshot();
  let markdown = parseNoteMarkdown(note.body, schema);
  let errors: NoteEditorErrors = { editing: null, save: '网络失败，结果待核对。' };
  const pending = new WeakMap<Transaction, NoteMarkdown>();
  let fail = true;
  let state = EditorState.create({ doc: markdown.doc, plugins: [new Plugin({ filterTransaction(transaction) {
    if (!transaction.docChanged) return true;
    const result = prepareNoteEdit(markdown, transaction.doc, content => {
      if (fail) throw new Error('受控转换异常');
      return serialize(content);
    });
    if (!result.ok) { errors = noteEditorErrors(errors, { type: 'edit-error', error: result.error }); return false; }
    pending.set(transaction, result.markdown); return true;
  } })] });
  const apply = (tr: Transaction) => {
    const result = state.applyTransaction(tr); state = result.state;
    if (!result.transactions.some(item => item.docChanged)) return;
    markdown = pending.get(tr)!;
    draft = { ...draft, body: markdown.source, edit: draft.edit + 1 };
    storage.save(draft); errors = noteEditorErrors(errors, { type: 'edit-accepted' });
  };
  apply(state.tr.addMark(1, 3, schema.marks.bold!.create()));
  assert.equal(errors.editing?.kind, 'conversion');
  assert.match(errors.editing!.message, /刚才这次正文修改未写入/);
  assert.match(errors.editing!.message, /正文和草稿已保留/);
  assert.equal(state.doc.textContent, note.body);
  assert.equal(markdown.source, note.body);
  assert.equal(draft.body, note.body); assert.equal(draft.edit, 0);
  assert.equal(local.snapshot(), before); assert.equal(storage.load(note).pending?.commandId, request.commandId);
  const alert = renderToStaticMarkup(createElement(NoteEditErrorNotice, { error: errors.editing, disabled: false, onReturn() {} }));
  assert.match(alert, /返回编辑/); assert.doesNotMatch(alert, /重试保存/);
  fail = false;
  apply(state.tr.insertText('合法输入', 2));
  assert.equal(errors.editing, null); assert.equal(errors.save, '网络失败，结果待核对。');
  assert.equal(draft.body, '原合法输入正文');
  assert.equal(draft.pending, request);
  assert.deepEqual(storage.load(note).pending, request);
  // 核对和迟到保存仍使用原命令，不能覆盖新输入或更高版本。
  const remote = { ...note, revision: 3, body: '服务端并发修改' };
  assert.equal(noteRefreshed(draft, remote), draft);
  const completed = noteSaved({ ...draft, base: remote }, { ...note, revision: 2, body: request.body }, request);
  assert.equal(completed.base, remote); assert.equal(completed.body, draft.body); assert.equal(completed.pending, null);
});

test('真实不可转换修改安全拒绝，错误原因与正文长度限制分别呈现', () => {
  const previous = parseNoteMarkdown(note.body, schema);
  const impossible = schema.node('doc', null, [schema.node('paragraph', null, schema.node('noteRawInline', { source: '**损坏' }))]);
  const refused = prepareNoteEdit(previous, impossible, serialize);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error.kind, 'conversion');
  assert.equal(previous.source, note.body);
  const long = schema.node('doc', null, [schema.node('paragraph', null, schema.text('长'.repeat(NOTE_BODY_LIMIT + 1)))]);
  const limited = prepareNoteEdit(previous, long, serialize);
  assert.equal(limited.ok, false);
  if (limited.ok) return;
  assert.equal(limited.error.kind, 'limit'); assert.match(limited.error.message, /请缩短该次输入/);
});

test('转换与保存错误独立呈现，返回编辑、合法编辑及保存回执各自只清除对应错误', () => {
  const previous = parseNoteMarkdown(note.body, schema);
  const result = prepareNoteEdit(previous, EditorState.create({ doc: previous.doc }).tr.addMark(1, 3, schema.marks.bold!.create()).doc, () => { throw new Error('受控转换异常'); });
  assert.equal(result.ok, false); if (result.ok) return;
  let errors = noteEditorErrors({ editing: null, save: '服务端保存失败' }, { type: 'edit-error', error: result.error });
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(NoteEditErrorNotice, { error: errors.editing, disabled: false, onReturn() {} }),
    createElement(NoteSaveErrorNotice, { message: errors.save, canRetry: true, busy: false, onRetry() {} }),
  ));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 2);
  assert.equal((html.match(/>重试保存</g) ?? []).length, 1);
  assert.equal((html.match(/>返回编辑</g) ?? []).length, 1);
  errors = noteEditorErrors(errors, { type: 'edit-dismissed' });
  assert.equal(errors.editing, null); assert.equal(errors.save, '服务端保存失败');
  errors = noteEditorErrors(errors, { type: 'edit-error', error: result.error });
  errors = noteEditorErrors(errors, { type: 'save-error', message: '' });
  assert.equal(errors.editing, result.error); assert.equal(errors.save, '');
  errors = noteEditorErrors(errors, { type: 'edit-accepted' });
  assert.equal(errors.editing, null);
  assert.equal(renderToStaticMarkup(createElement(NoteEditErrorNotice, { error: errors.editing, disabled: false, onReturn() {} })), '');
  assert.doesNotMatch(renderToStaticMarkup(createElement(NoteSaveErrorNotice, { message: '服务端版本待核对', canRetry: false, busy: false, onRetry() {} })), /重试保存/);
});

test('正文编辑不清除仍待处理的图片错误，返回编辑不修改保存错误', () => {
  const errors: NoteEditorErrors = { editing: { kind: 'image', message: '图片上传失败，请重试图片。' }, save: '原保存失败' };
  assert.equal(noteEditorErrors(errors, { type: 'edit-accepted' }), errors);
  assert.equal(noteEditorErrors(errors, { type: 'edit-dismissed' }).save, errors.save);
});
