import { BookSchema, BookListSchema, type Book, type BookSummary, type ImportBook } from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

export const listBooks = (): Promise<{ books: BookSummary[] }> => fetchJson('/api/reading/books', undefined, BookListSchema);
export const getBook = (id: string): Promise<Book> => fetchJson(`/api/reading/books/${encodeURIComponent(id)}`, undefined, BookSchema);
export const importBook = (input: ImportBook): Promise<Book> => fetchJson('/api/reading/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, BookSchema);
