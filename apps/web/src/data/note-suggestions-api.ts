import { NoteSuggestionListSchema, NoteSuggestionDecisionSchema, type NoteSuggestion, type NoteSuggestionDecision, type ImportNoteSuggestions, type DecideNoteSuggestion } from '@multivac/contracts';
import { notesRequest } from './notes-api.js';
const base = (id: string) => `/api/notes/${encodeURIComponent(id)}/suggestions`;
export const listNoteSuggestions = (id: string) => notesRequest<{ suggestions: NoteSuggestion[] }>(base(id), NoteSuggestionListSchema);
export const importNoteSuggestions = (id: string, input: ImportNoteSuggestions) => notesRequest<{ suggestions: NoteSuggestion[] }>(base(id), NoteSuggestionListSchema, 'POST', input);
export const decideNoteSuggestion = (id: string, suggestionId: string, input: DecideNoteSuggestion) => notesRequest<NoteSuggestionDecision>(`${base(id)}/${encodeURIComponent(suggestionId)}`, NoteSuggestionDecisionSchema, 'POST', input);
