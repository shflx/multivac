import { NoteDiscussionSchema, NoteSnapshotSchema, type NoteDiscussion, type NoteSnapshot, type PrepareNoteContext } from '@multivac/contracts';
import { notesRequest } from './notes-api.js';
const base = (id: string) => `/api/notes/${encodeURIComponent(id)}`;
export const ensureNoteCompanion = (id: string) => notesRequest<NoteDiscussion>(`${base(id)}/companion`, NoteDiscussionSchema, 'POST');
export const prepareNoteContext = (id: string, input: PrepareNoteContext) => notesRequest<NoteSnapshot>(`${base(id)}/contexts`, NoteSnapshotSchema, 'POST', input);
