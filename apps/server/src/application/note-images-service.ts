import { createHash } from 'node:crypto';
import type { NoteImage } from '@multivac/contracts';
import type { NoteImagesRepository } from '../modules/notes/note-image.js';
import type { NotesService } from './notes-service.js';
import { NotesError } from '../modules/notes/note.js';
import { validateImage } from './validate-image.js';

export class NoteImagesService {
  private disposed = false;
  constructor(private readonly repository: NoteImagesRepository, private readonly notes: NotesService) {}
  get(noteId: string, id: string) { return this.repository.get(noteId, id); }
  read(noteId: string, id: string) { return this.repository.read(noteId, id); }
  async upload(noteId: string, data: Buffer): Promise<NoteImage> {
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
