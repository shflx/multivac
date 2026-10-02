import { Type } from 'typebox';
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const ArtifactVersionSchema = Type.Object({
  artifactId: Id, versionId: Id, taskId: Id, runId: Id,
  version: Type.Integer({ minimum: 1 }), title: Type.String({ minLength: 1, maxLength: 200 }),
  sourceKind: Type.Union([Type.Literal('file'), Type.Literal('user-text')]),
  sourcePath: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), size: Type.Integer({ minimum: 1, maximum: 512 * 1024 }),
  fileKey: Id, createdAt: Type.String(),
  status: Type.Union([Type.Literal('submitted'), Type.Literal('accepted'), Type.Literal('changes')]),
  feedback: Type.String({ maxLength: 4000 }),
  checks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), passed: Type.Boolean(), evidence: Type.String({ maxLength: 1000 }) }, { additionalProperties: false }), { maxItems: 20 }),
}, { additionalProperties: false });
export type ArtifactVersion = Type.Static<typeof ArtifactVersionSchema>;
export const SubmitArtifactSchema = Type.Object({
  commandId: Id, revision: Type.Integer({ minimum: 1 }), runId: Id,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 128 * 1024 })),
}, { additionalProperties: false });
export type SubmitArtifact = Type.Static<typeof SubmitArtifactSchema>;
export const ArtifactContentSchema = Type.Object({ version: ArtifactVersionSchema, content: Type.String({ maxLength: 512 * 1024 }) }, { additionalProperties: false });
