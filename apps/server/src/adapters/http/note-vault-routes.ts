import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NoteSecurityService } from '../../application/note-security-service.js';
import { encryptNoteBytes, decryptNoteBytes, type NoteCiphertext } from '../../modules/notes/note-crypto.js';
import { NotesError } from '../../modules/notes/note.js';
import { readNotesInput, notesResponse, notesFailure } from './notes-routes.js';
import { noteRequestAccess } from './note-security-routes.js';

/** 浏览器只保存密文草稿包；密钥不离开服务端，换密码后原草稿仍可恢复。 */
export function createNoteVaultRequestHandler(service: NoteSecurityService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const match = /^\/api\/notes\/([^/]+)\/vault$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (!match) return false;
    try {
      if (request.method !== 'POST') throw new NotesError('草稿保护仅支持 POST。', 405);
      const noteId = decodeURIComponent(match[1]!), access = noteRequestAccess(request);
      service.assertAccess(noteId, access);
      const input = await readNotesInput(request, 16 * 1024 * 1024) as { action?: unknown; id?: unknown; content?: unknown };
      if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.id) || Object.keys(input).some(key => !['action', 'id', 'content'].includes(key))) throw new NotesError('草稿保护参数无效。');
      const aad = { noteId, kind: 'browser-draft', identity: input.id };
      const content = service.withDataKey(noteId, access, key => {
        if (input.action === 'seal' && typeof input.content === 'string') return encryptNoteBytes(key, Buffer.from(input.content), aad);
        if (input.action === 'open' && input.content && typeof input.content === 'object') return decryptNoteBytes(key, input.content as NoteCiphertext, aad).toString('utf8');
        throw new NotesError('草稿保护参数无效。');
      });
      notesResponse(response, 200, { content });
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
