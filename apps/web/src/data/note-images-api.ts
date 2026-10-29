import { noteFetch } from './note-access.js';
import { noteImageId, type NoteImage } from '@multivac/contracts';
import { NotesApiError } from './notes-api.js';

export async function uploadNoteImage(noteId: string, file: File, signal: AbortSignal): Promise<NoteImage> {
  const path = `/api/notes/${encodeURIComponent(noteId)}/images`;
  const response = await noteFetch(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, signal });
  let value: unknown;
  try { value = await response.json(); } catch { throw new NotesApiError('图片上传响应不可读，请重试同一图片。', response.status); }
  if (!response.ok) {
    const error = value as { error?: { message?: string } };
    throw new NotesApiError(error?.error?.message || '图片上传失败，请重试。', response.status);
  }
  const image = value as NoteImage;
  if (!image || !noteImageId(`note-image:${image.id}`) || image.noteId !== noteId) throw new NotesApiError('图片上传响应无效，请重试。', 500);
  return image;
}
