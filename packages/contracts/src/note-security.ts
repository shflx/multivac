/** 凭证仅保存在页面内存，通过请求头交付，不使用 URL 或浏览器持久存储。 */
export const NOTE_ACCESS_HEADER = 'x-note-access';
export const NOTE_WINDOW_HEADER = 'x-note-window';
export const NOTE_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export interface NoteSecurityStatus { configured: boolean; idleTimeoutMs: number }
export interface NoteUnlockResult { token: string; idleTimeoutMs: number }
export interface NoteAccess { token: string; window: string }
