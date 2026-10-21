import { Fragment, type Node as DocumentNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

/** 上传节点只存在于编辑现场；持久正文与引用映射使用移除占位后的文档。 */
export function noteWithoutUploads(node: DocumentNode): DocumentNode {
  if (node.isLeaf) return node;
  const content: DocumentNode[] = [];
  let changed = false;
  node.forEach(child => {
    if (child.type.name === 'noteImageUpload') { changed = true; return; }
    const next = noteWithoutUploads(child);
    content.push(next); changed ||= next !== child;
  });
  return changed ? node.copy(Fragment.fromArray(content)) : node;
}
export function noteUploadCount(doc: DocumentNode): number {
  let count = 0;
  doc.descendants(node => { if (node.type.name === 'noteImageUpload') count++; });
  return count;
}
export function notePositionWithoutUploads(doc: DocumentNode, position: number): number {
  let removed = 0;
  doc.descendants((node, offset) => { if (offset < position && node.type.name === 'noteImageUpload') removed++; });
  return position - removed;
}
export function noteUploadPosition(doc: DocumentNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, position) => { if (node.type.name === 'noteImageUpload' && node.attrs.id === id) found = position; });
  return found;
}
/** 始终寻找当前文档里的原占位；删除或换基线后不使用旧光标补插。 */
export function resolveNoteUpload(transaction: Transaction, id: string, imageId: string): boolean {
  const position = noteUploadPosition(transaction.doc, id);
  if (position === null) return false;
  const node = transaction.doc.nodeAt(position)!;
  transaction.setNodeMarkup(position, transaction.doc.type.schema.nodes.noteImage, { src: `note-image:${imageId}`, alt: node.attrs.alt, title: null });
  transaction.setMeta('addToHistory', false);
  return true;
}
