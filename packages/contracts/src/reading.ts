import { Type, type Static } from 'typebox';

export const BOOK_SOURCE_LIMIT_BYTES = 1024 * 1024;
export const BOOK_MAX_PARAGRAPHS = 5000;
export const BOOK_MAX_PARAGRAPH_LENGTH = 16384;
const Id = Type.String({ minLength: 1, maxLength: 100 });
export const BookParagraphSchema = Type.Object({ id: Id, text: Type.String({ minLength: 1, maxLength: BOOK_MAX_PARAGRAPH_LENGTH }) });
export const BookChapterSchema = Type.Object({ id: Id, title: Type.String({ maxLength: 300 }), paragraphs: Type.Array(BookParagraphSchema, { maxItems: BOOK_MAX_PARAGRAPHS }) });
export const BookSummarySchema = Type.Object({
  id: Id, version: Id, title: Type.String({ minLength: 1, maxLength: 200 }), author: Type.String({ maxLength: 200 }),
  format: Type.Union([Type.Literal('txt'), Type.Literal('md')]), createdAt: Type.String(),
  paragraphCount: Type.Integer({ minimum: 1, maximum: BOOK_MAX_PARAGRAPHS }),
});
export const BookSchema = Type.Intersect([BookSummarySchema, Type.Object({ chapters: Type.Array(BookChapterSchema, { minItems: 1, maxItems: 1000 }) })]);
export const BookListSchema = Type.Object({ books: Type.Array(BookSummarySchema, { maxItems: 200 }) });
export const ImportBookSchema = Type.Object({
  commandId: Id, title: Type.String({ minLength: 1, maxLength: 200 }), author: Type.String({ maxLength: 200 }),
  format: Type.Union([Type.Literal('txt'), Type.Literal('md')]), text: Type.String({ minLength: 1, maxLength: BOOK_SOURCE_LIMIT_BYTES }),
}, { additionalProperties: false });
export type Book = Static<typeof BookSchema>;
export type BookSummary = Static<typeof BookSummarySchema>;
export type ImportBook = Static<typeof ImportBookSchema>;

// 位置使用 UTF-16 偏移，与 DOM Range 和 JavaScript 字符串一致；端点不能拆开代理对。
export const BookPositionSchema = Type.Object({ chapterId: Id, paragraphId: Id, offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const BookReferenceSchema = Type.Object({ bookId: Id, version: Id, start: BookPositionSchema, end: BookPositionSchema, text: Type.String({ minLength: 1, maxLength: 65536 }) }, { additionalProperties: false });
export type BookPosition = Static<typeof BookPositionSchema>;
export type BookReference = Static<typeof BookReferenceSchema>;

export function bookParagraphs(book: Book) {
  return book.chapters.flatMap(chapter => chapter.paragraphs.map(paragraph => ({ ...paragraph, chapterId: chapter.id, chapterTitle: chapter.title })));
}
export function positionRank(book: Book, position: BookPosition): number {
  let rank = 0;
  for (const p of bookParagraphs(book)) {
    if (p.id === position.paragraphId && p.chapterId === position.chapterId) {
      const n = position.offset;
      if (!Number.isInteger(n) || n < 0 || n > p.text.length || (n > 0 && n < p.text.length && /[\uD800-\uDBFF]/u.test(p.text[n - 1]!) && /[\uDC00-\uDFFF]/u.test(p.text[n]!))) return -1;
      return rank + n;
    }
    rank += p.text.length + 1;
  }
  return -1;
}
export function referenceText(book: Book, start: BookPosition, end: BookPosition): string {
  const a = positionRank(book, start), b = positionRank(book, end);
  if (a < 0 || b <= a) return '';
  const ps = bookParagraphs(book);
  const i = ps.findIndex(p => p.id === start.paragraphId && p.chapterId === start.chapterId);
  const j = ps.findIndex(p => p.id === end.paragraphId && p.chapterId === end.chapterId);
  return ps.slice(i, j + 1).map((p, k) => p.text.slice(k === 0 ? start.offset : 0, i + k === j ? end.offset : p.text.length)).join('\n');
}
export function validBookReference(book: Book, reference: BookReference): boolean {
  return book.id === reference.bookId && book.version === reference.version && reference.text === referenceText(book, reference.start, reference.end);
}

export const ReadingAnnotationSchema = Type.Object({
  id: Id, bookId: Id, revision: Type.Integer({ minimum: 1 }), kind: Type.Union([Type.Literal('bookmark'), Type.Literal('highlight')]),
  reference: BookReferenceSchema, remark: Type.String({ maxLength: 2000 }), updatedAt: Type.String(),
}, { additionalProperties: false });
export const AnnotationListSchema = Type.Object({ records: Type.Array(ReadingAnnotationSchema, { maxItems: 2000 }) });
export const AnnotationCommandSchema = Type.Object({
  commandId: Id, id: Id, expectedRevision: Type.Integer({ minimum: 0 }),
  action: Type.Union([Type.Literal('save'), Type.Literal('delete')]),
  kind: Type.Union([Type.Literal('bookmark'), Type.Literal('highlight')]),
  reference: Type.Optional(BookReferenceSchema), remark: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });
export const AnnotationResultSchema = Type.Object({ record: Type.Union([ReadingAnnotationSchema, Type.Null()]) });
export type ReadingAnnotation = Static<typeof ReadingAnnotationSchema>;
export type AnnotationCommand = Static<typeof AnnotationCommandSchema>;

export const ReadingScopeSchema = Type.Object({ bookId: Id, version: Id, revision: Type.Integer({ minimum: 0 }), boundary: Type.Union([BookPositionSchema, Type.Null()]) });
export const ReadingScopeCommandSchema = Type.Object({ commandId: Id, expectedRevision: Type.Integer({ minimum: 0 }), boundary: Type.Union([BookPositionSchema, Type.Null()]) }, { additionalProperties: false });
export const ReadingDiscussionSchema = Type.Object({ sessionId: Id, bookId: Id, parentSessionId: Type.Union([Id, Type.Null()]), reference: Type.Union([BookReferenceSchema, Type.Null()]), title: Type.String(), createdAt: Type.String() });
export type ReadingScope = Static<typeof ReadingScopeSchema>;
export type ReadingScopeCommand = Static<typeof ReadingScopeCommandSchema>;
export type ReadingDiscussion = Static<typeof ReadingDiscussionSchema>;

const NoteFields = {
  id: Id, body: Type.String({ maxLength: 12000 }), reference: BookReferenceSchema,
  origin: Type.Union([Type.Literal('user'), Type.Literal('companion')]),
  discussion: Type.Optional(Type.Object({ sessionId: Id, piEntryId: Id }, { additionalProperties: false })),
};
export const ReadingNoteDraftSchema = Type.Object(NoteFields, { additionalProperties: false });
export const ReadingNoteSchema = Type.Object({ ...NoteFields, revision: Type.Integer({ minimum: 1 }), updatedAt: Type.String() }, { additionalProperties: false });
export const ReadingNotesStateSchema = Type.Object({ bookId: Id, revision: Type.Integer({ minimum: 0 }), notes: Type.Array(ReadingNoteSchema, { maxItems: 200 }), draft: Type.Union([ReadingNoteDraftSchema, Type.Null()]) }, { additionalProperties: false });
const NoteCommand = { commandId: Id, expectedRevision: Type.Integer({ minimum: 0 }) };
export const ReadingNotesCommandSchema = Type.Union([
  Type.Object({ ...NoteCommand, action: Type.Literal('draft'), draft: Type.Union([ReadingNoteDraftSchema, Type.Null()]), discardExisting: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ ...NoteCommand, action: Type.Literal('save'), nextDraft: Type.Optional(Type.Union([ReadingNoteDraftSchema, Type.Null()])) }, { additionalProperties: false }),
  Type.Object({ ...NoteCommand, action: Type.Literal('delete'), id: Id }, { additionalProperties: false }),
]);
export type ReadingNoteDraft = Static<typeof ReadingNoteDraftSchema>;
export type ReadingNote = Static<typeof ReadingNoteSchema>;
export type ReadingNotesState = Static<typeof ReadingNotesStateSchema>;
export type ReadingNotesCommand = Static<typeof ReadingNotesCommandSchema>;
export function hasUnsavedReadingNote(state: ReadingNotesState, draft = state.draft): boolean {
  if (!draft) return false;
  const saved = state.notes.find(n => n.id === draft.id);
  return !saved || saved.body !== draft.body || saved.origin !== draft.origin || JSON.stringify(saved.reference) !== JSON.stringify(draft.reference) || JSON.stringify(saved.discussion ?? null) !== JSON.stringify(draft.discussion ?? null);
}
