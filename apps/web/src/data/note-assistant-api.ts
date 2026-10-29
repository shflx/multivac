import { registerNoteSession } from './note-access.js';
import { NoteDiscussionSchema, NoteSnapshotSchema, type PrepareNoteContext } from '@multivac/contracts';
import { notesRequest } from './notes-api.js';
const base = (id: string) => `/api/notes/${encodeURIComponent(id)}`;
export const ensureNoteCompanion = async (id: string) => { const discussion = await notesRequest(`${base(id)}/companion`, NoteDiscussionSchema, 'POST'); registerNoteSession(id, discussion.sessionId); return discussion; };
export const prepareNoteContext = (id: string, input: PrepareNoteContext) => notesRequest(`${base(id)}/contexts`, NoteSnapshotSchema, 'POST', input);
