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
