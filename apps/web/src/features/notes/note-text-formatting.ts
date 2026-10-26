import type { Command } from '@tiptap/core';
import { toggleMark } from '@tiptap/pm/commands';

/** 与 Markdown 定界符一致：选区边界空白保留为正文，只格式化其中的文字。 */
export function toggleNoteTextMark(name: 'bold' | 'italic'): Command {
  return ({ state, dispatch }) => {
    const { from, to, empty } = state.selection;
    // 纯空白选区没有可放入格式定界符的文字；保持原文和选区。
    if (!empty && !state.doc.textBetween(from, to, '\n', '\ufffc').trim()) return true;
    return toggleMark(state.schema.marks[name]!)(state, dispatch);
  };
}
