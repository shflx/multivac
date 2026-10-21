import { createHash } from 'node:crypto';
import type { NoteImage } from '@multivac/contracts';
import type { NoteImagesRepository } from '../modules/notes/note-image.js';
import type { NotesService } from './notes-service.js';
import { NotesError } from '../modules/notes/note.js';
import { validateImage } from './validate-image.js';

export class NoteImagesService {
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: NoteImagesRepository, private readonly notes: NotesService) {}
  get(noteId: string, id: string) { return this.repository.get(noteId, id); }
  read(noteId: string, id: string) { return this.repository.read(noteId, id); }
  upload(noteId: string, data: Buffer): Promise<NoteImage> {
    // 所有上传共用有序解码队列，避免多批或多窗口同时解码耗尽内存。
    const operation = this.tail.then(() => this.save(noteId, data));
    this.tail = operation.catch(() => {});
    return operation;
  }
  private async save(noteId: string, data: Buffer): Promise<NoteImage> {
    if (this.disposed) throw new NotesError('笔记图片服务已关闭。', 503);
    this.notes.summary(noteId);
    const metadata = await validateImage(data);
    if (this.disposed) throw new NotesError('笔记图片服务已关闭。', 503);
    // 同一笔记和内容的重试沿用身份；不同笔记始终产生不同身份。
    const id = createHash('sha256').update('note-image\0').update(noteId).update('\0').update(data).digest('hex');
    return this.repository.insert({ id, noteId, mimeType: `image/${metadata.format}`, width: metadata.width!, height: metadata.height!, bytes: data.length, retained: false }, data);
  }
  dispose(): void { this.disposed = true; }
}
