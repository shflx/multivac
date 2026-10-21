import type { NoteImage } from '@multivac/contracts';

/** 笔记附件仓储；同步写入确保归属、额度和二进制一起提交。 */
export interface NoteImagesRepository {
  get(noteId: string, id: string): NoteImage;
  read(noteId: string, id: string): { image: NoteImage; data: Buffer };
  insert(image: NoteImage, data: Buffer): NoteImage;
  retainReferences(noteId: string, body: string): void;
}
