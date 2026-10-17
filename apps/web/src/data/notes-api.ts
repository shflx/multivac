import type { Static, TSchema } from 'typebox';
import { DeletedNoteSchema, type DeleteNote, NoteSchema, NoteListSchema, NoteVersionListSchema, type CreateNote, type UpdateNote, WINDOW_ID_HEADER } from '@multivac/contracts';
import { windowId } from './window-id.js';
import { requestJson, type JsonRequestErrors } from './http.js';

export class NotesApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const NOTES_ERRORS: JsonRequestErrors = {
  unreadable: (status) => new NotesApiError('服务响应无法解析，结果待核对，请重试原请求。', status),
  failed: (body, status) => {
    const error = body as { error?: { message?: unknown } };
    return new NotesApiError(typeof error?.error?.message === 'string' ? error.error.message : '笔记请求失败。', status);
  },
  invalid: () => new NotesApiError('笔记响应无效，结果待核对，请重试原请求。', 500),
};

/** 笔记接口请求：返回类型由 schema 推导；失败映射为 NotesApiError。 */
export function notesRequest<S extends TSchema>(path: string, schema: S, method = 'GET', input?: unknown): Promise<Static<S>> {
  return requestJson(path, schema, {
    method, headers: { 'content-type': 'application/json', [WINDOW_ID_HEADER]: windowId() },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }, NOTES_ERRORS);
}
export const listNotes = () => notesRequest('/api/notes', NoteListSchema);
export const getNote = (id: string) => notesRequest(`/api/notes/${encodeURIComponent(id)}`, NoteSchema);
export const createNote = (input: CreateNote) => notesRequest('/api/notes', NoteSchema, 'POST', input);
export const updateNote = (id: string, input: UpdateNote) => notesRequest(`/api/notes/${encodeURIComponent(id)}`, NoteSchema, 'PUT', input);

export const listNoteVersions = (id: string, before?: number) => notesRequest(`/api/notes/${encodeURIComponent(id)}/versions${before === undefined ? '' : `?before=${before}`}`, NoteVersionListSchema);
export const getNoteVersion = (id: string, revision: number) => notesRequest(`/api/notes/${encodeURIComponent(id)}/versions/${revision}`, NoteSchema);

export const deleteNote = (id: string, input: DeleteNote) => notesRequest(`/api/notes/${encodeURIComponent(id)}`, DeletedNoteSchema, 'DELETE', input);
