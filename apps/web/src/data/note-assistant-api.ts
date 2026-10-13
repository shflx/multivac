import { NoteDiscussionSchema, NoteDiscussionListSchema, NoteSnapshotSchema, type NoteDiscussion, type NoteSnapshot, type PrepareNoteContext, type CreateNoteDiscussion } from '@multivac/contracts';
import { notesRequest } from './notes-api.js';
const base = (id: string) => `/api/notes/${encodeURIComponent(id)}`;
export const ensureNoteCompanion = (id: string) => notesRequest<NoteDiscussion>(`${base(id)}/companion`, NoteDiscussionSchema, 'POST');
export const noteDiscussions = (id: string) => notesRequest<{ discussions: NoteDiscussion[] }>(`${base(id)}/discussions`, NoteDiscussionListSchema);
export const prepareNoteContext = (id: string, input: PrepareNoteContext) => notesRequest<NoteSnapshot>(`${base(id)}/contexts`, NoteSnapshotSchema, 'POST', input);
export const deepenNoteDiscussion = (id: string, input: CreateNoteDiscussion) => notesRequest<NoteDiscussion>(`${base(id)}/discussions`, NoteDiscussionSchema, 'POST', input);
