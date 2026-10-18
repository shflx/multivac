import { Type, type Static } from 'typebox';
import { McpRuleTargetSchema } from './mcp-schemas.js';

const id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const object = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
export const McpManagementProposalSchema = Type.Union([
  object({ action: Type.Literal('import'), config: Type.String({ maxLength: 256000 }), source: Type.String({ minLength: 1, maxLength: 4096 }), serviceId: Type.Optional(id), revision: Type.Optional(Type.Integer({ minimum: 1 })) }),
  object({ action: Type.Literal('state'), serviceId: id, revision: Type.Integer({ minimum: 1 }), state: Type.Enum(['enable', 'disable', 'remove']) }),
  object({ action: Type.Literal('rule'), serviceId: id, revision: Type.Integer({ minimum: 0 }), target: McpRuleTargetSchema }),
  object({ action: Type.Literal('connect'), serviceId: id, accountId: id, sessionId: id }),
]);
export type McpManagementProposal = Static<typeof McpManagementProposalSchema>;
export const McpManagementProposalPreviewSchema = object({
  commandId: id, fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  facts: Type.Record(Type.String(), Type.Unknown()), impact: Type.String(), expiresAt: Type.String(),
});
export type McpManagementProposalPreview = Static<typeof McpManagementProposalPreviewSchema>;
