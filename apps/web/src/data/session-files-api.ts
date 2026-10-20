import { SessionFileContentSchema, SessionFileListSchema, SessionFileTargetSchema, SessionFileRevealResultSchema, type SessionFileContent, type SessionFileEntry, type SessionFileList, type SessionFileTarget } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export function listSessionFiles(sessionId: string, path: string, query: string, root: string, signal?: AbortSignal): Promise<SessionFileList> {
  const params = new URLSearchParams({ path, query, root });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files?${params}`, signal ? { signal } : undefined, SessionFileListSchema);
}

export function getSessionFileTarget(sessionId: string, path: string, root: string, kind: SessionFileEntry['kind']): Promise<SessionFileTarget> {
  const params = new URLSearchParams({ path, root, kind });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files/target?${params}`, undefined, SessionFileTargetSchema);
}

export function revealSessionFile(sessionId: string, path: string, root: string, kind: SessionFileEntry['kind']): Promise<{ message: string }> {
  const params = new URLSearchParams({ path, root, kind });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files/reveal?${params}`, { method: 'POST', body: '{}' }, SessionFileRevealResultSchema);
}

export function readSessionFile(sessionId: string, path: string, root: string, signal?: AbortSignal): Promise<SessionFileContent> {
  const params = new URLSearchParams({ path, root });
  return fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/files/content?${params}`, signal ? { signal } : undefined, SessionFileContentSchema);
}
