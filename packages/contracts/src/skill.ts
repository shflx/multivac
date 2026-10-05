import { Type, type Static } from 'typebox';

export const SkillRefSchema = Type.Object({ skillId: Type.String({ minLength: 1, maxLength: 100 }), version: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false });
export type SkillRef = Static<typeof SkillRefSchema>;
export interface SkillManifest {
  name: string;
  description: string;
  metadata: Record<string, unknown>;
  diagnostics: string[];
  dependencies: { source: 'declared' | 'unknown'; tools: string[] };
  files: { path: string; bytes: number; hash: string }[];
  version: string;
}
export interface SkillRecord extends SkillRef {
  name: string;
  displayName: string;
  description: string;
  source: string;
  projectId: string | null;
  revision: number;
  enabled: boolean;
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}
export const SkillImportSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 4096 }),
  projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  displayName: Type.String({ maxLength: 128 }),
  skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export type SkillImport = Static<typeof SkillImportSchema>;
export interface SkillPreview { previewId: string; input: SkillImport; manifest: SkillManifest; previousVersion: string | null; body: string; changes: string[] }
export const SkillConfirmSchema = Type.Object({ commandId: Type.String({ minLength: 1, maxLength: 128 }), previewId: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const SkillStateSchema = Type.Object({ commandId: Type.String({ minLength: 1, maxLength: 128 }), skillId: Type.String({ minLength: 1, maxLength: 100 }), revision: Type.Integer({ minimum: 1 }), action: Type.Union([Type.Literal('enable'), Type.Literal('disable'), Type.Literal('remove')]) }, { additionalProperties: false });
export interface SkillContext { projectId: string | null; sessionId: string | null; host: 'work' | 'task' | 'reading'; tools: readonly string[] }
export interface SkillAvailability { record: SkillRecord; available: boolean; reasons: string[]; dependencies: SkillManifest['dependencies']; hidden: boolean; closed: boolean }
export const SkillPreferenceSchema = Type.Object({
  commandId: Type.String({ minLength: 1, maxLength: 128 }), skillId: Type.String({ minLength: 1, maxLength: 100 }),
  projectId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]), sessionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  revision: Type.Integer({ minimum: 0 }), hidden: Type.Boolean(),
}, { additionalProperties: false });
