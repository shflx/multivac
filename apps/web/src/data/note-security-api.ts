import { authorizeNote, forgetNoteAccess, noteHeaders, noteGeneration, noteResponse } from './note-access.js';

export async function noteSecurityRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const started = noteGeneration();
  const response = await fetch(path, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...noteHeaders(path) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (path.endsWith('/vault')) noteResponse(path, response, started);
  const value = await response.json() as { error?: { message?: string } };
  if (path.endsWith('/vault')) noteResponse(path, response, started);
  if (!response.ok) throw new Error(value.error?.message ?? '笔记安全操作失败，请核对当前状态。');
  return value as T;
}
export async function unlockNote(id: string, password: string) {
  const result = await noteSecurityRequest<{ token: string }>(`/api/notes/${encodeURIComponent(id)}/unlock`, 'POST', { password });
  authorizeNote(id, result.token);
}
export async function lockNote(id: string) {
  await noteSecurityRequest(`/api/notes/${encodeURIComponent(id)}/lock`, 'POST'); forgetNoteAccess(id);
}
export function noteProtection(id: string) { return noteSecurityRequest<{ state: 'plain' | 'encrypting' | 'encrypted' | 'decrypting' }>(`/api/notes/${encodeURIComponent(id)}/protection`); }
export async function convertNote(id: string, action: 'encrypt' | 'decrypt' | 'recover', expectedRevision?: number) {
  const result = await noteSecurityRequest<{ state: 'plain' | 'encrypting' | 'encrypted' | 'decrypting' }>(`/api/notes/${encodeURIComponent(id)}/protection`, 'POST', { action, ...(expectedRevision ? { expectedRevision } : {}) });
  return result;
}
