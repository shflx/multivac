import { Type, type Static } from 'typebox';

export const SESSION_FILE_LIMITS = { directoryEntries: 500, searchEntries: 4000, searchResults: 200, depth: 20, pathLength: 4096, contentBytes: 512 * 1024 } as const;

export const SessionFileEntrySchema = Type.Object({
  name: Type.String(), path: Type.String(), kind: Type.Union([Type.Literal('directory'), Type.Literal('file')]),
});
export type SessionFileEntry = Static<typeof SessionFileEntrySchema>;

export const SessionFileListSchema = Type.Object({
  root: Type.String(), path: Type.String(), entries: Type.Array(SessionFileEntrySchema), limited: Type.Boolean(),
});
export type SessionFileList = Static<typeof SessionFileListSchema>;
