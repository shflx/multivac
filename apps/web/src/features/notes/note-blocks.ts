import type { Node as DocumentNode } from '@tiptap/pm/model';

export interface NoteBlock { index: number; from: number; to: number; nodes: { node: DocumentNode; pos: number }[] }

/** 只扫描文档直属节点；分隔线两侧即使没有内容，也各占一个块。 */
export function noteBlocks(doc: DocumentNode): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let block: NoteBlock = { index: 0, from: 0, to: 0, nodes: [] };
  doc.forEach((node, pos) => {
    if (node.type.name === 'horizontalRule') {
      block.to = pos; blocks.push(block);
      block = { index: blocks.length, from: pos + node.nodeSize, to: pos + node.nodeSize, nodes: [] };
    } else block.nodes.push({ node, pos });
  });
  block.to = doc.content.size; blocks.push(block);
  return blocks;
}

export const noteBlocksKey = (noteId: string) => `multivac.notes.blocks.${noteId}`;
export function loadNoteBlocks(noteId: string): boolean {
  try { return localStorage.getItem(noteBlocksKey(noteId)) === 'true'; } catch { return false; }
}
export function clearNoteBlocks(noteId: string) {
  try { localStorage.removeItem(noteBlocksKey(noteId)); localStorage.removeItem(`${noteBlocksKey(noteId)}.folded`); } catch { /* 删除结果仍以服务端为准。 */ }
}
