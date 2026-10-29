import { NOTE_ACCESS_HEADER, NOTE_GRANTS_HEADER, NOTE_WINDOW_HEADER, NOTE_IDLE_TIMEOUT_MS } from '@multivac/contracts';

const tokens = new Map<string, string>();
const preparing = new Set<string>();
const owners = new Map<string, string>();
const protectedNotes = new Set<string>();
const listeners = new Set<() => void>();
const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
const activity = new Map<string, number>();
let generation = 0;
export const noteGeneration = () => generation;
export const onNoteAccessChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function changed() { generation++; for (const listener of listeners) listener(); }
export const protectedNote = (id: string) => protectedNotes.has(id);
export const hasNoteAccess = (id: string) => tokens.has(id);
export const unlockedNote = (id: string) => tokens.has(id) && !preparing.has(id);
export function markProtected(id: string) { protectedNotes.add(id); }
export function markOrdinary(id: string) { protectedNotes.delete(id); }
export function registerNoteSession(noteId: string, sessionId: string) { owners.set(sessionId, noteId); }
export const sessionNoteOwner = (id: string) => owners.get(id);
export function authorizeNote(id: string, token: string) { tokens.set(id, token); preparing.add(id); activity.set(id, Date.now()); changed(); }
export function activateNote(id: string) { preparing.delete(id); changed(); }
export function forgetNoteAccess(id: string) { if (tokens.delete(id)) { preparing.delete(id); activity.delete(id); changed(); } }
export function noteHeaders(path: string): Record<string, string> {
  if (path.split('?')[0] === '/api/events') return { [NOTE_WINDOW_HEADER]: secret, [NOTE_GRANTS_HEADER]: JSON.stringify(Object.fromEntries(tokens)) };
  const note = /^\/api\/notes\/([^/]+)/u.exec(path), session = /^\/api\/sessions\/([^/]+)/u.exec(path);
  const id = note ? decodeURIComponent(note[1]!) : session ? owners.get(decodeURIComponent(session[1]!)) : undefined;
  return { [NOTE_WINDOW_HEADER]: secret, ...(id && tokens.has(id) ? { [NOTE_ACCESS_HEADER]: tokens.get(id)! } : {}) };
}
export function noteResponse(path: string, response: Response, started: number) {
  const note = /^\/api\/notes\/([^/]+)/u.exec(path), session = /^\/api\/sessions\/([^/]+)/u.exec(path);
  const id = note ? decodeURIComponent(note[1]!) : session ? owners.get(decodeURIComponent(session[1]!)) : undefined;
  if (id && response.status === 423 && started === generation) forgetNoteAccess(id);
  if (id && protectedNotes.has(id) && (started !== generation || !tokens.has(id)) && response.ok) throw new Error('笔记访问资格已变化，请重新读取。');
}
export async function noteFetch(path: string, init?: RequestInit): Promise<Response> {
  const started = noteGeneration(), headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(noteHeaders(path))) headers.set(key, value);
  const response = await fetch(path, { ...init, headers, cache: 'no-store' });
  noteResponse(path, response, started);
  const content = await response.arrayBuffer();
  noteResponse(path, response, started);
  return new Response(content.byteLength ? content : null, { status: response.status, statusText: response.statusText, headers: response.headers });
}
export async function verifyNoteAccess(pause = false) {
  const checked = [...tokens], paused = new Set(pause ? checked.filter(([id]) => !preparing.has(id)).map(([id]) => id) : []);
  if (paused.size) { for (const id of paused) preparing.add(id); changed(); }
  await Promise.all(checked.map(async ([id, token]) => {
    try {
      const response = await fetch(`/api/notes/${encodeURIComponent(id)}/access`, { headers: noteHeaders(`/api/notes/${id}`), cache: 'no-store' });
      if (tokens.get(id) !== token) return;
      if (!response.ok) forgetNoteAccess(id); else if (paused.has(id)) activateNote(id);
    } catch { if (tokens.get(id) === token) forgetNoteAccess(id); }
  }));
}
export function noteUserActivity(id: string) {
  if (!tokens.has(id)) return;
  const now = Date.now(), last = activity.get(id) ?? 0;
  if (now - last >= NOTE_IDLE_TIMEOUT_MS) { forgetNoteAccess(id); return; }
  activity.set(id, now);
  if (now - (touched.get(id) ?? 0) < 15_000) return;
  touched.set(id, now);
  void fetch(`/api/notes/${encodeURIComponent(id)}/activity`, { method: 'POST', headers: noteHeaders(`/api/notes/${id}`) }).then(response => { if (!response.ok) forgetNoteAccess(id); }, () => forgetNoteAccess(id));
}
const touched = new Map<string, number>();
if (typeof window !== 'undefined') {
  setInterval(() => { for (const [id, last] of activity) if (Date.now() - last >= NOTE_IDLE_TIMEOUT_MS) forgetNoteAccess(id); }, 1000);
  window.addEventListener('pagehide', () => {
    for (const id of [...tokens.keys()]) {
      void fetch(`/api/notes/${encodeURIComponent(id)}/lock`, { method: 'POST', headers: noteHeaders(`/api/notes/${id}`), keepalive: true }).catch(() => {});
      forgetNoteAccess(id);
    }
  });
  window.addEventListener('focus', () => { void verifyNoteAccess(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void verifyNoteAccess(true); });
}
