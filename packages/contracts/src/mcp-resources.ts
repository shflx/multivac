import { Type, type Static } from 'typebox';
const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const version = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const McpResourceReferenceSchema = Type.Object({
  snapshotId: id, serviceId: id, serviceName: Type.String({ maxLength: 128 }), accountId: id, accountLabel: Type.String({ maxLength: 128 }),
  accountRevision: Type.Integer({ minimum: 1 }), configVersion: version, catalogVersion: version,
  uri: Type.String({ minLength: 1, maxLength: 4096 }), mimeType: Type.String({ maxLength: 256 }), readAt: Type.String(), truncated: Type.Boolean(),
}, { additionalProperties: false });
export type McpResourceReference = Static<typeof McpResourceReferenceSchema>;
export const McpResourceSelectionSchema = Type.Object({ sessionId: id, connectionId: id, catalogVersion: version,
  uri: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), template: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  parameters: Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' }), Type.String({ maxLength: 1024 }), { maxProperties: 16 }),
}, { additionalProperties: false });
export type McpResourceSelection = Static<typeof McpResourceSelectionSchema>;
export const McpResourceReadSchema = Type.Object({ ...McpResourceSelectionSchema.properties, commandId: id, fingerprint: version }, { additionalProperties: false });
export type McpResourceRead = Static<typeof McpResourceReadSchema>;
export interface McpResourceReadPreview { selection: McpResourceSelection; uri: string; fingerprint: string; evidence: Record<string, unknown>; impact: string }
export interface McpResourceReadResult { status: 'not-started' | 'unknown' | 'succeeded'; snapshot: import('./mcp.js').McpResourceSnapshot | null }
