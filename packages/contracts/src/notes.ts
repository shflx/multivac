import { Type, type Static } from 'typebox';

/** 独立应用笔记，与 reading 的书籍笔记没有数据或迁移关系。 */
export const NOTE_BODY_LIMIT = 100_000;
export const NOTE_CONTEXT_LIMIT = 48_000;
export const NoteIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const NoteSchema = Type.Object({
  id: NoteIdSchema,
  title: Type.String({ maxLength: 200 }),
  body: Type.String({ maxLength: NOTE_BODY_LIMIT }),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false });
export type Note = Static<typeof NoteSchema>;
export const NoteSummarySchema = Type.Omit(NoteSchema, ['body']);
export const NoteListSchema = Type.Object({ notes: Type.Array(NoteSummarySchema, { maxItems: 1000 }) }, { additionalProperties: false });
export type NoteSummary = Omit<Note, 'body'>;
/** 版本列表只读摘要；使用版本号游标，新增保存不会扰动较早版本的分页。 */
export const NoteVersionListSchema = Type.Object({
  versions: Type.Array(NoteSummarySchema, { maxItems: 50 }),
  latestRevision: Type.Integer({ minimum: 1 }),
  nextBefore: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
}, { additionalProperties: false });
export type NoteVersionList = Static<typeof NoteVersionListSchema>;
export const CreateNoteSchema = Type.Object({
  commandId: NoteIdSchema, id: NoteIdSchema,
  title: Type.String({ maxLength: 200 }), body: Type.String({ maxLength: NOTE_BODY_LIMIT }),
}, { additionalProperties: false });
export const UpdateNoteSchema = Type.Object({
  commandId: NoteIdSchema, expectedRevision: Type.Integer({ minimum: 1 }),
  title: Type.String({ maxLength: 200 }), body: Type.String({ maxLength: NOTE_BODY_LIMIT }),
}, { additionalProperties: false });
export type CreateNote = Static<typeof CreateNoteSchema>;
export type UpdateNote = Static<typeof UpdateNoteSchema>;

/** Multivac 只修改用户指定的字段；其余字段在同一版本校验事务中保留。 */
export const UpdateNoteFieldsSchema = Type.Object({
  commandId: NoteIdSchema, expectedRevision: Type.Integer({ minimum: 1 }),
  title: Type.Optional(Type.String({ maxLength: 200 })),
  body: Type.Optional(Type.String({ maxLength: NOTE_BODY_LIMIT })),
}, { additionalProperties: false, minProperties: 3 });
export type UpdateNoteFields = Static<typeof UpdateNoteFieldsSchema>;

/** textarea 使用 UTF-16 偏移；保留有意义空白，端点不能截开代理对。 */
export const NoteSelectionSchema = Type.Object({
  start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1, maxLength: 16_000 }),
}, { additionalProperties: false });
export type NoteSelection = Static<typeof NoteSelectionSchema>;
export function noteBoundary(body: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > body.length) return false;
  return !(offset > 0 && offset < body.length && /[\uD800-\uDBFF]/u.test(body[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(body[offset]!));
}
export function validNoteSelection(body: string, selection: NoteSelection): boolean {
  return selection.end > selection.start && noteBoundary(body, selection.start) && noteBoundary(body, selection.end)
    && body.slice(selection.start, selection.end) === selection.text;
}
