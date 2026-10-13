import { Type, type Static } from 'typebox';
import { NoteIdSchema, NoteSchema } from './notes.js';

/** 模型仅提供文本编辑意图；身份、版本、位置及决定均由服务端确定。 */
export const NoteSuggestionOutputSchema = Type.Object({ suggestions: Type.Array(Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  before: Type.String({ minLength: 1, maxLength: 16000 }),
  after: Type.String({ maxLength: 16000 }),
}, { additionalProperties: false }), { minItems: 1, maxItems: 8 }) }, { additionalProperties: false });
export type NoteSuggestionOutput = Static<typeof NoteSuggestionOutputSchema>;
export const NoteSuggestionSchema = Type.Object({
  id: NoteIdSchema, noteId: NoteIdSchema, sessionId: NoteIdSchema, snapshotId: NoteIdSchema,
  sourcePiSessionId: Type.String({ minLength: 1 }), sourcePiEntryId: Type.String({ minLength: 1 }),
  baseRevision: Type.Integer({ minimum: 1 }), start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }), before: Type.String({ minLength: 1, maxLength: 16000 }), after: Type.String({ maxLength: 16000 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('stale')]),
  problem: Type.Union([Type.String(), Type.Null()]), createdAt: Type.String(), decidedAt: Type.Union([Type.String(), Type.Null()]),
  appliedRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type NoteSuggestion = Static<typeof NoteSuggestionSchema>;
export const NoteSuggestionListSchema = Type.Object({ suggestions: Type.Array(NoteSuggestionSchema, { maxItems: 2000 }) });
export const ImportNoteSuggestionsSchema = Type.Object({ commandId: NoteIdSchema, sessionId: NoteIdSchema, piEntryId: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false });
export type ImportNoteSuggestions = Static<typeof ImportNoteSuggestionsSchema>;
export const DecideNoteSuggestionSchema = Type.Object({
  commandId: NoteIdSchema, expectedRevision: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal('accept'), Type.Literal('reject')]),
}, { additionalProperties: false });
export type DecideNoteSuggestion = Static<typeof DecideNoteSuggestionSchema>;
export const NoteSuggestionDecisionSchema = Type.Object({ note: NoteSchema, suggestion: NoteSuggestionSchema }, { additionalProperties: false });
export type NoteSuggestionDecision = Static<typeof NoteSuggestionDecisionSchema>;
