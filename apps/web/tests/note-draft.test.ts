import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialNoteDraft, noteSaved, noteRefreshed, noteDirty } from '../src/features/notes/note-draft.js';
import type { Note } from '@multivac/contracts';
const note: Note = { id: 'a', title: '标题', body: '旧正文', revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
test('保存期间的新输入不被迟到回执清除，旧快照与其他笔记不回退当前版本', () => {
  const request = { commandId: 'save', expectedRevision: 1, title: note.title, body: '已发送正文' };
  const local = { ...initialNoteDraft(note), body: '后来的输入', edit: 2, pending: request };
  const saved = { ...note, body: request.body, revision: 2 };
  const next = noteSaved(local, saved, request);
  assert.equal(next.body, local.body); assert.equal(next.base.revision, 2); assert.ok(noteDirty(next));
  assert.equal(noteRefreshed(next, { ...saved, body: '其他窗口', revision: 3 }), next);
  assert.equal(noteRefreshed(next, note), next);
  assert.equal(noteSaved(local, { ...saved, id: 'b' }, request), local);
  assert.equal(noteSaved(local, saved, { ...request, commandId: 'other' }), local);
});
test('未修改的编辑器采用新服务端版本，未知保存不被刷新清空', () => {
  const local = initialNoteDraft(note), saved = { ...note, revision: 2, body: '新正文' };
  assert.equal(noteRefreshed(local, saved).body, saved.body);
  const pending = { ...local, pending: { commandId: 'unknown', expectedRevision: 1, title: note.title, body: note.body } };
  assert.equal(noteRefreshed(pending, saved), pending);
});
