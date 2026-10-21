import type { IncomingMessage, ServerResponse } from 'node:http';
import { NOTE_IMAGE_LIMITS } from '@multivac/contracts';
import type { NoteImagesService } from '../../application/note-images-service.js';
import { ImageError } from '../../application/image-service.js';
import { NotesError } from '../../modules/notes/note.js';
import { notesFailure, notesResponse } from './notes-routes.js';

export function createNoteImagesRequestHandler(service: NoteImagesService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const match = /^\/api\/notes\/([^/]+)\/images(?:\/([a-f0-9]{64})(?:\/(content))?)?$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (!match) return false;
    try {
      const noteId = decodeURIComponent(match[1]!);
      if (request.method === 'POST' && !match[2]) {
        if (Number(request.headers['content-length']) > NOTE_IMAGE_LIMITS.bytes) throw new NotesError('单图上限为 10 MiB。', 413);
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > NOTE_IMAGE_LIMITS.bytes) throw new NotesError('单图上限为 10 MiB。', 413);
          chunks.push(buffer);
        }
        notesResponse(response, 200, await service.upload(noteId, Buffer.concat(chunks)));
      } else if (request.method === 'GET' && match[2]) {
        if (match[3]) {
          const { image, data } = service.read(noteId, match[2]);
          response.writeHead(200, { 'content-type': image.mimeType, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
          response.end(data);
        } else notesResponse(response, 200, service.get(noteId, match[2]));
      } else throw new NotesError('不支持的笔记图片操作。', 405);
    } catch (error) { notesFailure(response, error instanceof ImageError ? new NotesError(error.message, error.status) : error); }
    return true;
  };
}
