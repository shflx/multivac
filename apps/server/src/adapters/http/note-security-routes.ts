import type { IncomingMessage, ServerResponse } from 'node:http';
import { NOTE_ACCESS_HEADER, NOTE_WINDOW_HEADER, type NoteAccess } from '@multivac/contracts';
import type { NoteSecurityService } from '../../application/note-security-service.js';
import { NotesError } from '../../modules/notes/note.js';
import { notesFailure, notesResponse } from './notes-routes.js';

export function noteRequestAccess(request: IncomingMessage): NoteAccess | undefined {
  const token = request.headers[NOTE_ACCESS_HEADER], window = request.headers[NOTE_WINDOW_HEADER];
  return typeof token === 'string' && typeof window === 'string' ? { token, window } : undefined;
}
/** 密码正文独立读取并限制大小，不进入通用命令回执或日志。 */
async function passwordInput(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new NotesError('密码请求必须使用 JSON。', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 16_384) throw new NotesError('密码请求超过大小限制。', 413);
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotesError('密码请求无效。');
  return value as Record<string, unknown>;
}
export function createNoteSecurityRequestHandler(service: NoteSecurityService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = /^\/api\/notes\/([^/]+)\/(unlock|lock|access|activity)$/u.exec(path);
    if (path !== '/api/note-security' && path !== '/api/note-security/password' && !match) return false;
    try {
      if (path === '/api/note-security') {
        if (request.method !== 'GET') throw new NotesError('不支持的密码操作。', 405);
        notesResponse(response, 200, service.status());
      } else if (path === '/api/note-security/password') {
        if (!['POST', 'PUT'].includes(request.method ?? '')) throw new NotesError('不支持的密码操作。', 405);
        const input = await passwordInput(request);
        if (typeof input.password !== 'string' || Object.keys(input).some(key => !['password', 'currentPassword'].includes(key))) throw new NotesError('密码请求无效。');
        if (request.method === 'POST') await service.initialize(input.password);
        else {
          if (typeof input.currentPassword !== 'string') throw new NotesError('请输入原共用密码。');
          await service.changePassword(input.currentPassword, input.password);
        }
        notesResponse(response, 200, service.status());
      } else if (match) {
        const noteId = decodeURIComponent(match[1]!);
        const action = match[2]!;
        if (action === 'unlock') {
          if (request.method !== 'POST') throw new NotesError('不支持的解锁操作。', 405);
          const input = await passwordInput(request);
          const window = request.headers[NOTE_WINDOW_HEADER];
          if (typeof input.password !== 'string' || typeof window !== 'string' || Object.keys(input).length !== 1) throw new NotesError('解锁请求无效。');
          notesResponse(response, 200, await service.unlock(noteId, input.password, window));
        } else {
          if (request.method !== (action === 'access' ? 'GET' : 'POST')) throw new NotesError('不支持的解锁操作。', 405);
          const access = noteRequestAccess(request);
          service.assertAccess(noteId, access);
          if (action === 'activity') service.touch(noteId, access!);
          if (action === 'lock') service.lock(noteId, access!);
          notesResponse(response, 200, { unlocked: action !== 'lock' });
        }
      }
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
