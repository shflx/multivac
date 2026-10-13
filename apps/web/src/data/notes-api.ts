import { Check } from 'typebox/value';
import { NoteSchema, NoteListSchema, type Note, type NoteSummary, type CreateNote, type UpdateNote, WINDOW_ID_HEADER } from '@multivac/contracts';
import { windowId } from './window-id.js';
import { notifyAccessFailure } from './access-api.js';

export class NotesApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function notesRequest<T>(path: string, schema: object, method = 'GET', input?: unknown): Promise<T> {
  const response = await fetch(path, {
    method, headers: { 'content-type': 'application/json', [WINDOW_ID_HEADER]: windowId() },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  notifyAccessFailure(response);
  let value: unknown;
  try { value = await response.json(); } catch { throw new NotesApiError('服务响应无法解析，结果待核对，请重试原请求。', response.status); }
  if (!response.ok) {
    const error = value as { error?: { message?: unknown } };
    throw new NotesApiError(typeof error?.error?.message === 'string' ? error.error.message : '笔记请求失败。', response.status);
  }
  if (!Check(schema, value)) throw new NotesApiError('笔记响应无效，结果待核对，请重试原请求。', 500);
  return value as T;
}
export const listNotes = () => notesRequest<{ notes: NoteSummary[] }>('/api/notes', NoteListSchema);
export const getNote = (id: string) => notesRequest<Note>(`/api/notes/${encodeURIComponent(id)}`, NoteSchema);
export const createNote = (input: CreateNote) => notesRequest<Note>('/api/notes', NoteSchema, 'POST', input);
export const updateNote = (id: string, input: UpdateNote) => notesRequest<Note>(`/api/notes/${encodeURIComponent(id)}`, NoteSchema, 'PUT', input);
