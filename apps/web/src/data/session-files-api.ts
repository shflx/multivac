import { SessionFileContentSchema, SessionFileListSchema, type SessionFileContent, type SessionFileList } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export function listSessionFiles(sessionId: string, path: string, query: string, root: string, signal?: AbortSignal): Promise<SessionFileList> {
  const params = new URLSearchParams({ path, query, root });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files?${params}`, signal ? { signal } : undefined, SessionFileListSchema);
}

export function readSessionFile(sessionId: string, path: string, root: string, signal?: AbortSignal): Promise<SessionFileContent> {
  const params = new URLSearchParams({ path, root });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files/content?${params}`, signal ? { signal } : undefined, SessionFileContentSchema);
}
