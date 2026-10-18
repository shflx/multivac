import { Type, type Static } from 'typebox';
import { NoteIdSchema, NoteSelectionSchema } from './notes.js';

export const NoteSnapshotSchema = Type.Object({
  id: NoteIdSchema, sessionId: NoteIdSchema, noteId: NoteIdSchema,
  revision: Type.Integer({ minimum: 1 }), selection: Type.Union([NoteSelectionSchema, Type.Null()]),
}, { additionalProperties: false });
export type NoteSnapshot = Static<typeof NoteSnapshotSchema>;
export const PrepareNoteContextSchema = Type.Object({
  commandId: NoteIdSchema, id: NoteIdSchema, sessionId: NoteIdSchema,
  revision: Type.Integer({ minimum: 1 }), selection: Type.Union([NoteSelectionSchema, Type.Null()]),
}, { additionalProperties: false });
export type PrepareNoteContext = Static<typeof PrepareNoteContextSchema>;
export const NoteDiscussionSchema = Type.Object({
  sessionId: NoteIdSchema, noteId: NoteIdSchema,
  parentSessionId: Type.Union([NoteIdSchema, Type.Null()]),
  title: Type.String({ maxLength: 80 }), createdAt: Type.String(),
  topic: Type.Union([Type.Object({ snapshotId: NoteIdSchema, text: Type.String({ maxLength: 16000 }), sourceRuntimeEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })) }, { additionalProperties: false }), Type.Null()]),
}, { additionalProperties: false });
export type NoteDiscussion = Static<typeof NoteDiscussionSchema>;
export const NoteDiscussionListSchema = Type.Object({ discussions: Type.Array(NoteDiscussionSchema, { maxItems: 100 }) });
export const CreateNoteDiscussionSchema = Type.Object({
  commandId: NoteIdSchema, sessionId: NoteIdSchema, parentSessionId: NoteIdSchema,
  source: Type.Union([
    Type.Object({ kind: Type.Literal('selection'), snapshotId: NoteIdSchema }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('message'), runtimeEntryId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type CreateNoteDiscussion = Static<typeof CreateNoteDiscussionSchema>;
