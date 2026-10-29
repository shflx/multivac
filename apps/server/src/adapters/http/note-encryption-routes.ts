import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NoteEncryption } from '../../modules/notes/encryption.js';
import { NotesError } from '../../modules/notes/note.js';
import { notesFailure, notesResponse, readNotesInput } from './notes-routes.js';
import { noteRequestAccess } from './note-security-routes.js';

export function createNoteEncryptionRequestHandler(service: NoteEncryption) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const match = /^\/api\/notes\/([^/]+)\/protection$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (!match) return false;
    try {
      const noteId = decodeURIComponent(match[1]!);
      if (request.method === 'GET') { notesResponse(response, 200, service.status(noteId)); return true; }
      if (request.method !== 'POST') throw new NotesError('不支持的加密操作。', 405);
      const access = noteRequestAccess(request);
      if (!access) throw new NotesError('请先输入共用密码。', 423);
      const input = await readNotesInput(request) as Record<string, unknown>;
      if (!input || !['encrypt', 'decrypt', 'recover'].includes(String(input.action)) || Object.keys(input).some(key => !['action', 'expectedRevision'].includes(key))) throw new NotesError('加密操作参数无效。');
      if (input.action === 'recover') service.recover(noteId, access);
      else {
        if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new NotesError('请先核对已保存的笔记版本。');
        if (input.action === 'encrypt') service.encrypt(noteId, Number(input.expectedRevision), access);
        else service.decrypt(noteId, Number(input.expectedRevision), access);
      }
      notesResponse(response, 200, service.status(noteId));
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
