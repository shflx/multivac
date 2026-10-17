import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { CreateNoteSchema, UpdateNoteSchema, DeleteNoteSchema } from '@multivac/contracts';
import type { NotesService } from '../../application/notes-service.js';
import { NotesError } from '../../modules/notes/note.js';

export async function readNotesInput(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new NotesError('笔记请求必须使用 JSON。', 415);
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 800_000) throw new NotesError('笔记请求超过大小限制。', 413);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function notesResponse(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export function notesFailure(response: ServerResponse, error: unknown) {
  const status = error instanceof NotesError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
  notesResponse(response, status, { error: { code: status === 409 ? 'NOTE_CONFLICT' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? '笔记保存或读取失败，请重试。' : (error as Error).message } });
}
export function createNotesRequestHandler(service: NotesService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const versionPath = /^\/api\/notes\/([^/]+)\/versions(?:\/([^/]+))?$/u.exec(path);
    if (path !== '/api/notes' && !/^\/api\/notes\/[^/]+$/u.test(path) && !versionPath) return false;
    try {
      if (versionPath) {
        if (request.method !== 'GET') throw new NotesError('笔记版本仅支持读取。', 405);
        const id = decodeURIComponent(versionPath[1]!);
        const positiveInteger = (value: string): number => {
          if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new NotesError('版本号或分页参数无效。');
          return Number(value);
        };
        if (versionPath[2] !== undefined) {
          if (url.search) throw new NotesError('读取版本不接受查询参数。');
          notesResponse(response, 200, service.get(id, positiveInteger(versionPath[2])));
        } else {
          if ([...url.searchParams.keys()].some(key => !['before', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new NotesError('版本分页参数无效。');
          const before = url.searchParams.has('before') ? positiveInteger(url.searchParams.get('before')!) : undefined;
          const limit = url.searchParams.has('limit') ? positiveInteger(url.searchParams.get('limit')!) : undefined;
          notesResponse(response, 200, service.versions(id, before, limit));
        }
      } else if (path === '/api/notes') {
        if (request.method === 'GET') notesResponse(response, 200, { notes: service.list() });
        else if (request.method === 'POST') {
          const input = await readNotesInput(request);
          if (!Check(CreateNoteSchema, input)) throw new NotesError('新建笔记参数无效。');
          notesResponse(response, 200, service.create(input));
        } else throw new NotesError('不支持的笔记操作。', 405);
      } else {
        const id = decodeURIComponent(path.split('/').at(-1)!);
        if (request.method === 'GET') notesResponse(response, 200, service.get(id));
        else if (request.method === 'PUT') {
          const input = await readNotesInput(request);
          if (!Check(UpdateNoteSchema, input)) throw new NotesError('保存笔记参数无效。');
          notesResponse(response, 200, service.update(id, input));
        } else if (request.method === 'DELETE') {
          const input = await readNotesInput(request);
          if (!Check(DeleteNoteSchema, input)) throw new NotesError('删除笔记参数无效。');
          notesResponse(response, 200, service.remove(id, input));
        } else throw new NotesError('不支持的笔记操作。', 405);
      }
    } catch (error) { notesFailure(response, error); }
    return true;
  };
}
