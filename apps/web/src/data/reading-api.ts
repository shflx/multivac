import { BookIndexSchema, BookWindowSchema, BookSummarySchema, type BookIndex, type BookWindow, type BookUpload } from '@multivac/contracts';
import { BookSchema, BookListSchema, AnnotationListSchema, AnnotationResultSchema, ReadingDiscussionSchema, ReadingScopeSchema, type ReadingScope, type ReadingScopeCommand, type ReadingDiscussion, type ReadingAnnotation, type AnnotationCommand, type Book, type BookSummary, type ImportBook } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';
import { ReadingNotesStateSchema, type ReadingNotesState, type ReadingNotesCommand } from '@multivac/contracts';
import { ReadingDiscussionListSchema, type CreateReadingDiscussion } from '@multivac/contracts';

export const listBooks = (): Promise<{ books: BookSummary[] }> => fetchJson('/api/reading/books', undefined, BookListSchema);
export const getBook = (id: string): Promise<Book> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}`, undefined, BookSchema);
export const importBook = (input: ImportBook): Promise<Book> => fetchJson('/api/reading/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, BookSchema);
export const listAnnotations = (id: string): Promise<{ records: ReadingAnnotation[] }> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/annotations`, undefined, AnnotationListSchema);
export const annotateBook = (id: string, command: AnnotationCommand): Promise<{ record: ReadingAnnotation | null }> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, AnnotationResultSchema);
export const getReadingScope = (id: string): Promise<ReadingScope> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/scope`, undefined, ReadingScopeSchema);
export const setReadingScope = (id: string, command: ReadingScopeCommand): Promise<ReadingScope> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, ReadingScopeSchema);
export const ensureBookCompanion = (id: string): Promise<ReadingDiscussion> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/companion`, { method: 'POST' }, ReadingDiscussionSchema);
export const getReadingNotes = (id: string): Promise<ReadingNotesState> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/notes`, undefined, ReadingNotesStateSchema);
export const mutateReadingNotes = (id: string, command: ReadingNotesCommand): Promise<ReadingNotesState> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, ReadingNotesStateSchema);
export const listReadingDiscussions = (id?: string): Promise<{ discussions: ReadingDiscussion[] }> => fetchJson(id ? `/api/reading/books/${encodeURIComponent(id)}/discussions` : '/api/reading/discussions', undefined, ReadingDiscussionListSchema);
export const createReadingDiscussion = (id: string, command: CreateReadingDiscussion): Promise<ReadingDiscussion> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/discussions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, ReadingDiscussionSchema);

export const getBookIndex = (id: string): Promise<BookIndex> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/index`, undefined, BookIndexSchema);
export const getBookWindow = (id: string, block: number): Promise<BookWindow> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/content?block=${block}`, undefined, BookWindowSchema);
export const uploadBook = (metadata: BookUpload, file: File, signal: AbortSignal): Promise<BookSummary> => fetchJson(`/api/reading/books/upload?${new URLSearchParams(metadata)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, signal }, BookSummarySchema);
