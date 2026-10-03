import { BookSchema, BookListSchema, AnnotationListSchema, AnnotationResultSchema, ReadingDiscussionSchema, ReadingScopeSchema, type ReadingScope, type ReadingScopeCommand, type ReadingDiscussion, type ReadingAnnotation, type AnnotationCommand, type Book, type BookSummary, type ImportBook } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export const listBooks = (): Promise<{ books: BookSummary[] }> => fetchJson('/api/reading/books', undefined, BookListSchema);
export const getBook = (id: string): Promise<Book> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}`, undefined, BookSchema);
export const importBook = (input: ImportBook): Promise<Book> => fetchJson('/api/reading/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, BookSchema);
export const listAnnotations = (id: string): Promise<{ records: ReadingAnnotation[] }> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/annotations`, undefined, AnnotationListSchema);
export const annotateBook = (id: string, command: AnnotationCommand): Promise<{ record: ReadingAnnotation | null }> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, AnnotationResultSchema);
export const getReadingScope = (id: string): Promise<ReadingScope> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/scope`, undefined, ReadingScopeSchema);
export const setReadingScope = (id: string, command: ReadingScopeCommand): Promise<ReadingScope> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/scope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) }, ReadingScopeSchema);
export const ensureBookCompanion = (id: string): Promise<ReadingDiscussion> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}/companion`, { method: 'POST' }, ReadingDiscussionSchema);
