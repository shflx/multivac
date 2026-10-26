import type { JSONContent } from '@tiptap/core';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { NOTE_BODY_LIMIT } from '@multivac/contracts';
import { updateNoteMarkdown, type NoteMarkdown } from './note-markdown.js';

export interface NoteEditError {
  kind: 'conversion' | 'limit' | 'image';
  message: string;
}

/** 接受前完成转换核对；拒绝时不写正文、草稿或保存命令。 */
export function prepareNoteEdit(previous: NoteMarkdown, doc: DocumentNode, serialize: (content: JSONContent) => string, pasted?: NoteMarkdown):
  { ok: true; markdown: NoteMarkdown } | { ok: false; error: NoteEditError } {
  try {
    const markdown = pasted?.doc.eq(doc) ? pasted : updateNoteMarkdown(previous, doc, serialize);
    if (markdown.source.length > NOTE_BODY_LIMIT) return { ok: false, error: {
      kind: 'limit', message: `刚才这次正文修改未写入：正文不能超过 ${NOTE_BODY_LIMIT.toLocaleString()} 个字符。修改前的正文和草稿已保留，请缩短该次输入。`,
    } };
    return { ok: true, markdown };
  } catch {
    return { ok: false, error: {
      kind: 'conversion', message: '刚才这次正文修改未写入：无法无损转换为 Markdown。修改前的正文和草稿已保留，请返回编辑，调整该次修改后再试。',
    } };
  }
}

export interface NoteEditorErrors { editing: NoteEditError | null; save: string }
type ErrorEvent = { type: 'edit-error'; error: NoteEditError } | { type: 'save-error'; message: string } | { type: 'edit-accepted' | 'edit-dismissed' };

export function noteEditorErrors(state: NoteEditorErrors, event: ErrorEvent): NoteEditorErrors {
  switch (event.type) {
    case 'save-error': return { ...state, save: event.message };
    case 'edit-error': return { ...state, editing: event.error };
    case 'edit-accepted': return state.editing?.kind === 'image' ? state : { ...state, editing: null };
    case 'edit-dismissed': return { ...state, editing: null };
  }
}
