import { Type, type Static } from 'typebox';

export const SESSION_FILE_LIMITS = { directoryEntries: 500, searchEntries: 4000, searchResults: 200, depth: 20, pathLength: 4096, contentBytes: 512 * 1024, contentLines: 20000 } as const;

export const SessionFileEntrySchema = Type.Object({
  name: Type.String(), path: Type.String(), kind: Type.Union([Type.Literal('directory'), Type.Literal('file')]),
});
export type SessionFileEntry = Static<typeof SessionFileEntrySchema>;

export const SessionFileListSchema = Type.Object({
  root: Type.String(), path: Type.String(), entries: Type.Array(SessionFileEntrySchema), limited: Type.Boolean(),
});
export type SessionFileList = Static<typeof SessionFileListSchema>;

export const SessionFileContentSchema = Type.Object({
  root: Type.String(), path: Type.String(), text: Type.String(), bytes: Type.Integer({ minimum: 0 }),
  kind: Type.Union([Type.Literal('markdown'), Type.Literal('typescript'), Type.Literal('html'), Type.Literal('text')]),
});
export type SessionFileContent = Static<typeof SessionFileContentSchema>;

export const SessionFileReferenceSchema = Type.Object({
  root: Type.String({ minLength: 1, maxLength: 4096 }), path: Type.String({ minLength: 1, maxLength: 4096 }), href: Type.String({ minLength: 1, maxLength: 8192 }),
  line: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), endLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })), section: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });
export type SessionFileReference = Static<typeof SessionFileReferenceSchema>;
