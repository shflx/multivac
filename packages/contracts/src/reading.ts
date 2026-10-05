import { Type, type Static } from 'typebox';

export const BOOK_SOURCE_LIMIT_BYTES = 1024 * 1024;
export const BOOK_BINARY_LIMIT_BYTES = 20 * 1024 * 1024;
export const BOOK_EXTRACTED_LIMIT_BYTES = 8 * 1024 * 1024;
export const BOOK_MAX_PARAGRAPHS = 5000;
export const BOOK_MAX_PARAGRAPH_LENGTH = 16384;
const Id = Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' });
export const BookParagraphSchema = Type.Object({ id: Id, text: Type.String({ minLength: 1, maxLength: BOOK_MAX_PARAGRAPH_LENGTH }) });
export const BookChapterSchema = Type.Object({ id: Id, title: Type.String({ maxLength: 300 }), paragraphs: Type.Array(BookParagraphSchema, { maxItems: 100000 }) });
export const BookSummarySchema = Type.Object({
  id: Id, version: Id, title: Type.String({ minLength: 1, maxLength: 200 }), author: Type.String({ maxLength: 200 }),
  format: Type.Union([Type.Literal('txt'), Type.Literal('md'), Type.Literal('pdf'), Type.Literal('epub')]), createdAt: Type.String(),
  paragraphCount: Type.Integer({ minimum: 1, maximum: 100000 }),
});
export const BookSchema = Type.Intersect([BookSummarySchema, Type.Object({ chapters: Type.Array(BookChapterSchema, { minItems: 1, maxItems: 10000 }) })]);
export const BookListSchema = Type.Object({ books: Type.Array(BookSummarySchema, { maxItems: 200 }) });
const BookImportMetadata = {
  commandId: Id, title: Type.String({ minLength: 1, maxLength: 200 }), author: Type.String({ maxLength: 200 }),
};
export const ImportBookSchema = Type.Union([
  Type.Object({ ...BookImportMetadata,
    format: Type.Union([Type.Literal('txt'), Type.Literal('md')]), text: Type.String({ minLength: 1, maxLength: BOOK_SOURCE_LIMIT_BYTES }),
  }, { additionalProperties: false }),
  Type.Object({ ...BookImportMetadata,
    format: Type.Union([Type.Literal('pdf'), Type.Literal('epub')]),
    dataBase64: Type.String({ minLength: 4, maxLength: Math.ceil(BOOK_BINARY_LIMIT_BYTES / 3) * 4 }),
  }, { additionalProperties: false }),
]);
export type Book = Static<typeof BookSchema>;
export type BookSummary = Static<typeof BookSummarySchema>;
export type ImportBook = Static<typeof ImportBookSchema>;
export type TextBookImport = Extract<ImportBook, { text: string }>;
export type BinaryBookImport = Extract<ImportBook, { dataBase64: string }>;

// 位置使用 UTF-16 偏移，与 DOM Range 和 JavaScript 字符串一致；端点不能拆开代理对。
export const BookPositionSchema = Type.Object({ chapterId: Id, paragraphId: Id, offset: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const BookReferenceSchema = Type.Object({ bookId: Id, version: Id, start: BookPositionSchema, end: BookPositionSchema, text: Type.String({ minLength: 1, maxLength: 65536 }) }, { additionalProperties: false });
export type BookPosition = Static<typeof BookPositionSchema>;
export type BookReference = Static<typeof BookReferenceSchema>;
/** 阅读位置不携带摘录；章节、段落与偏移不随字号或分页变化。 */
export const BookLocationSchema = Type.Object({ bookId: Id, version: Id, position: BookPositionSchema }, { additionalProperties: false });
export type BookLocation = Static<typeof BookLocationSchema>;
export function bookLocation(source: BookReference | BookLocation): BookLocation {
  return 'position' in source ? source : { bookId: source.bookId, version: source.version, position: source.start };
}

export const BookUploadSchema = Type.Object({
  commandId: Id, title: Type.String({ minLength: 1, maxLength: 200 }), author: Type.String({ maxLength: 200 }),
  format: Type.Union([Type.Literal('pdf'), Type.Literal('epub')]),
}, { additionalProperties: false });
export type BookUpload = Static<typeof BookUploadSchema>;
export const BOOK_CONTENT_BLOCK_LENGTH = 65536;
export const BookIndexSchema = Type.Intersect([BookSummarySchema, Type.Object({
  blockCount: Type.Integer({ minimum: 1, maximum: 100000 }),
  chapters: Type.Array(Type.Object({ id: Id, title: Type.String({ maxLength: 300 }), paragraphs: Type.Array(Type.Object({
    id: Id, length: Type.Integer({ minimum: 1, maximum: BOOK_MAX_PARAGRAPH_LENGTH }),
    rank: Type.Integer({ minimum: 0 }), block: Type.Integer({ minimum: 0 }),
  }), { maxItems: 100000 }) }), { maxItems: 10000 }),
})]);
export type BookIndex = Static<typeof BookIndexSchema>;
export const BookWindowSchema = Type.Object({ book: BookSchema, block: Type.Integer({ minimum: 0 }) });
export type BookWindow = Static<typeof BookWindowSchema>;


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
export function validBookLocation(book: Book, location: BookLocation): boolean {
  return book.id === location.bookId && book.version === location.version && positionRank(book, location.position) >= 0;
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
export const ReadingMessageSourceSchema = Type.Object({ sessionId: Id, piEntryId: Id }, { additionalProperties: false });
export const ReadingDiscussionSchema = Type.Object({ sessionId: Id, bookId: Id, parentSessionId: Type.Union([Id, Type.Null()]), reference: Type.Union([BookReferenceSchema, Type.Null()]), title: Type.String(), createdAt: Type.String(), sourceMessage: Type.Optional(Type.Object({ sessionId: Id, piEntryId: Id, text: Type.String({ maxLength: 16000 }) })) });
export const ReadingDiscussionListSchema = Type.Object({ discussions: Type.Array(ReadingDiscussionSchema, { maxItems: 20000 }) });
export const CreateReadingDiscussionSchema = Type.Object({ commandId: Id, sessionId: Id, parentSessionId: Id, source: Type.Union([
  Type.Object({ kind: Type.Literal('selection'), reference: BookReferenceSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('message'), message: ReadingMessageSourceSchema }, { additionalProperties: false }),
]) }, { additionalProperties: false });
export type ReadingMessageSource = Static<typeof ReadingMessageSourceSchema>;
export type CreateReadingDiscussion = Static<typeof CreateReadingDiscussionSchema>;
export type ReadingScope = Static<typeof ReadingScopeSchema>;
export type ReadingScopeCommand = Static<typeof ReadingScopeCommandSchema>;
export type ReadingDiscussion = Static<typeof ReadingDiscussionSchema>;

const NoteFields = {
  id: Id, body: Type.String({ maxLength: 12000 }), location: Type.Optional(BookLocationSchema), reference: Type.Optional(BookReferenceSchema),
  origin: Type.Union([Type.Literal('user'), Type.Literal('companion')]),
  discussion: Type.Optional(Type.Object({ sessionId: Id, piEntryId: Id }, { additionalProperties: false })),
};
// 兼容只有引用的旧记录；新笔记始终写入 location，不靠摘录承担定位职责。
const NoteLocationSchema = Type.Union([Type.Object({ location: BookLocationSchema }), Type.Object({ reference: BookReferenceSchema })]);
export const ReadingNoteDraftSchema = Type.Intersect([Type.Object(NoteFields, { additionalProperties: false }), NoteLocationSchema]);
export const ReadingNoteSchema = Type.Intersect([Type.Object({ ...NoteFields, revision: Type.Integer({ minimum: 1 }), updatedAt: Type.String() }, { additionalProperties: false }), NoteLocationSchema]);
export const ReadingNotesStateSchema = Type.Object({ bookId: Id, revision: Type.Integer({ minimum: 0 }), notes: Type.Array(ReadingNoteSchema, { maxItems: 200 }), draft: Type.Union([ReadingNoteDraftSchema, Type.Null()]) }, { additionalProperties: false });
const NoteCommand = { commandId: Id, expectedRevision: Type.Integer({ minimum: 0 }) };
export const ReadingNotesCommandSchema = Type.Union([
  Type.Object({ ...NoteCommand, action: Type.Literal('draft'), draft: Type.Union([ReadingNoteDraftSchema, Type.Null()]), discardExisting: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ ...NoteCommand, action: Type.Literal('save'), nextDraft: Type.Optional(Type.Union([ReadingNoteDraftSchema, Type.Null()])) }, { additionalProperties: false }),
  Type.Object({ ...NoteCommand, action: Type.Literal('delete'), id: Id, discardDraft: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
]);
export type ReadingNoteDraft = Static<typeof ReadingNoteDraftSchema>;
export type ReadingNote = Static<typeof ReadingNoteSchema>;
export type ReadingNotesState = Static<typeof ReadingNotesStateSchema>;
export type ReadingNotesCommand = Static<typeof ReadingNotesCommandSchema>;
export function readingNoteLocation(note: Pick<ReadingNoteDraft, 'location' | 'reference'>): BookLocation {
  return note.location ?? bookLocation(note.reference!);
}
export function normalizeReadingNote<T extends ReadingNoteDraft>(note: T): T & { location: BookLocation } {
  return { ...note, location: readingNoteLocation(note) };
}
export function normalizeReadingNotesState(state: ReadingNotesState): ReadingNotesState {
  return { ...state, notes: state.notes.map(normalizeReadingNote), draft: state.draft ? normalizeReadingNote(state.draft) : null };
}
export function hasUnsavedReadingNote(state: ReadingNotesState, draft = state.draft): boolean {
  if (!draft) return false;
  const saved = state.notes.find(n => n.id === draft.id);
  return !saved || saved.body !== draft.body || saved.origin !== draft.origin || JSON.stringify(readingNoteLocation(saved)) !== JSON.stringify(readingNoteLocation(draft)) || JSON.stringify(saved.reference) !== JSON.stringify(draft.reference) || JSON.stringify(saved.discussion ?? null) !== JSON.stringify(draft.discussion ?? null);
}

export const ReadingCollectionTargetSchema = Type.Object({ id: Id, title: Type.String({ minLength: 1, maxLength: 100 }), createdAt: Type.String() }, { additionalProperties: false });
export const ReadingCollectionTargetsSchema = Type.Object({ targets: Type.Array(ReadingCollectionTargetSchema, { maxItems: 20 }) });
export const CreateReadingCollectionTargetSchema = Type.Object({ commandId: Id, title: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const CollectReadingCommandSchema = Type.Object({ commandId: Id, targetId: Id, source: Type.Union([
  Type.Object({ kind: Type.Literal('excerpt'), reference: BookReferenceSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('reading-note'), bookId: Id, noteId: Id, noteRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('companion'), bookId: Id, message: ReadingMessageSourceSchema }, { additionalProperties: false }),
]) }, { additionalProperties: false });
export const ReadingCollectionItemSchema = Type.Intersect([Type.Object({ id: Id, targetId: Id, kind: Type.Union([Type.Literal('excerpt'), Type.Literal('reading-note'), Type.Literal('companion')]), body: Type.String({ minLength: 1, maxLength: 16000 }), location: Type.Optional(BookLocationSchema), reference: Type.Optional(BookReferenceSchema), bookTitle: Type.String(), createdAt: Type.String(), discussion: Type.Optional(ReadingMessageSourceSchema), sourceNote: Type.Optional(Type.Object({ id: Id, revision: Type.Integer({ minimum: 1 }) })) }, { additionalProperties: false }), NoteLocationSchema]);
export const ReadingCollectionListSchema = Type.Object({ items: Type.Array(ReadingCollectionItemSchema, { maxItems: 2000 }) });
export type ReadingCollectionTarget = Static<typeof ReadingCollectionTargetSchema>;
export type CollectReadingCommand = Static<typeof CollectReadingCommandSchema>;
export type ReadingCollectionItem = Static<typeof ReadingCollectionItemSchema>;

/** 本轮原文来源的语义；当前页是自动上下文，其余是用户明确选择的引用。 */
export const ReadingReferenceKindSchema = Type.Union([Type.Literal('current-page'), Type.Literal('selection'), Type.Literal('follow-up'), Type.Literal('discussion')]);
export type ReadingReferenceKind = Type.Static<typeof ReadingReferenceKindSchema>;

/** 发送时固定的相邻页面位置；正文仅在工具调用时由服务端读取。 */
export const ReadingPageRangeSchema = Type.Object({ start: BookPositionSchema, end: BookPositionSchema }, { additionalProperties: false });
export const ReadingAdjacentPagesSchema = Type.Object({ previous: Type.Union([ReadingPageRangeSchema, Type.Null()]), next: Type.Union([ReadingPageRangeSchema, Type.Null()]) }, { additionalProperties: false });
export type ReadingAdjacentPages = Static<typeof ReadingAdjacentPagesSchema>;
export const READING_PAGE_TOOL_NAMES: readonly string[] = ['read_previous_page', 'read_next_page'];
