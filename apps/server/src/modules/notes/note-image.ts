import { noteImageReferences, type NoteImage } from '@multivac/contracts';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

/** 同时检查原文保留协议与解析后的地址，字符实体不能绕过归属校验。 */
export function noteBodyImageReferences(body: string): string[] {
  const ids = new Set(noteImageReferences(body));
  function visit(node: Nodes): void {
    if ('url' in node && /^note-image:/iu.test(node.url)) for (const id of noteImageReferences(node.url)) ids.add(id);
    if ('children' in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(body));
  return [...ids];
}

/** 笔记附件仓储；同步写入确保归属、额度和二进制一起提交。 */
export interface NoteImagesRepository {
  get(noteId: string, id: string): NoteImage;
  read(noteId: string, id: string): { image: NoteImage; data: Buffer };
  insert(image: NoteImage, data: Buffer): NoteImage;
  retainReferences(noteId: string, body: string): void;
}
