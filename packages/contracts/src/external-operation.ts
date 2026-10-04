import { Type } from 'typebox';
export const ProposeGitPublishSchema = Type.Object({
  remote: Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_-]+$' }),
  branch: Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9/_-]*$' }),
}, { additionalProperties: false });
export type ProposeGitPublish = Type.Static<typeof ProposeGitPublishSchema>;
export const ExternalOperationSchema = Type.Object({
  id: Type.String(), sessionId: Type.String(), taskId: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('denied'), Type.Literal('invalidated'), Type.Literal('executing'), Type.Literal('unknown'), Type.Literal('succeeded')]),
  repository: Type.String(), remote: Type.String(), target: Type.String(), ref: Type.String(), commit: Type.String(), summary: Type.String(),
  account: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), result: Type.String(),
}, { additionalProperties: false });
export type ExternalOperation = Type.Static<typeof ExternalOperationSchema>;
