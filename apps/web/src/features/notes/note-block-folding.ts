import type { Node as DocumentNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import { noteBlocks, noteBlocksKey, type NoteBlock } from './note-blocks.js';

export function noteBlockPreview(block: NoteBlock) {
  const text = block.nodes.map(({ node }) => node.type.name === 'noteRawBlock' ? String(node.attrs.source) : node.textBetween(0, node.content.size, '\n', leaf => leaf.type.name === 'noteImage' ? `图片 · ${String(leaf.attrs.alt || '未命名')}` : '\n')).join('\n');
  const lines = text.split(/\r?\n/);
  const first = lines[0] || '空块';
  // 仅存文本指纹，避免加密笔记的首行明文进入本机偏好存储。
  let hash = 2166136261;
  for (let i = 0; i < first.length; i++) hash = Math.imul(hash ^ first.charCodeAt(i), 16777619);
  return { first, remaining: Math.max(0, lines.length - 1), key: `${block.index}:${(hash >>> 0).toString(16)}` };
}
export const noteBlockFoldsKey = (noteId: string) => `${noteBlocksKey(noteId)}.folded`;
export function loadNoteBlockFolds(noteId: string): Set<string> {
  try { const value: unknown = JSON.parse(localStorage.getItem(noteBlockFoldsKey(noteId)) ?? '[]'); return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string' && /^\d+:[\da-f]+$/.test(key)) : []); }
  catch { return new Set(); }
}
export function reconcileNoteBlockFolds(folded: Set<string>, doc: DocumentNode, selection?: Selection): Set<string> {
  const next = new Set<string>();
  for (const block of noteBlocks(doc)) {
    const key = noteBlockPreview(block).key;
    const entered = selection && (selection.empty ? selection.from >= block.from && selection.from <= block.to : selection.from <= block.to && selection.to >= block.from);
    if (folded.has(key) && !entered) next.add(key);
  }
  return next.size === folded.size && [...next].every(key => folded.has(key)) ? folded : next;
}
