import { Type, type TSchema } from 'typebox';

const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ pattern: '^[A-Za-z0-9._:-]{1,128}$' });
const version = Type.String({ pattern: '^[a-f0-9]{64}$' });
const revision = Type.Integer({ minimum: 1 });
const text = Type.String({ maxLength: 4096 });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumeration = <T extends string>(values: readonly T[]) => Type.Enum(values);
const data = Type.Record(Type.String(), Type.Unknown());
export const McpEffectsSchema = Type.Array(enumeration(['read', 'local-write', 'external-write', 'data-transfer']), { maxItems: 4, uniqueItems: true });
export const McpTransportSchema = Type.Union([
  object({ kind: Type.Literal('stdio'), command: text, args: Type.Array(text, { maxItems: 128 }), cwd: nullable(text), environmentKeys: Type.Array(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' }), { maxItems: 64, uniqueItems: true }) }),
  object({ kind: Type.Literal('streamable-http'), url: text }),
  object({ kind: Type.Literal('legacy-sse'), url: text }),
]);
const binding = { serviceId: id, accountId: id, accountRevision: revision, configVersion: version };
const catalogBinding = { ...binding, catalogVersion: version };
const errorCode = nullable(enumeration([
  'not-found', 'conflict', 'invalid-config', 'unsupported-transport', 'unsupported-protocol', 'credential-unavailable',
  'identity-changed', 'catalog-changed', 'rule-denied', 'classification-required', 'authorization-required',
  'authorization-invalid', 'connection-failed', 'timeout', 'cancelled', 'result-unknown', 'limit-exceeded',
]));
export const McpToolSchema = object({
  toolId: id, name: Type.String({ minLength: 1, maxLength: 256 }), description: Type.String({ maxLength: 16384 }),
  inputSchema: data, outputSchema: nullable(data), definitionVersion: version, annotations: data,
});
export const McpRuleTargetSchema = Type.Union([
  object({ kind: Type.Literal('project'), projectId: id, excluded: Type.Boolean(), accountId: nullable(id) }),
  object({ kind: Type.Literal('agent'), agentId: id, preferred: Type.Boolean(), effectCeiling: McpEffectsSchema }),
  object({ kind: Type.Literal('session'), sessionId: id, disabled: Type.Boolean() }),
]);
export const McpOperationIdentitySchema = object({
  ...catalogBinding, serviceRevision: revision, toolId: id, definitionVersion: version,
  sessionId: id, projectId: nullable(id), commandId: id, toolCallId: id, taskId: nullable(id), runId: nullable(id), agentId: nullable(id),
  host: enumeration(['work', 'task', 'coordinator']),
  ruleVersions: Type.Array(object({ ruleId: id, revision }), { maxItems: 1024 }),
});
const resource = { name: text, description: Type.String({ maxLength: 16384 }), mimeType: nullable(Type.String({ maxLength: 256 })) };
export const McpFactSchemas = {
  service: object({ serviceId: id, revision, name: Type.String({ minLength: 1, maxLength: 128 }), source: text,
    transport: McpTransportSchema, configVersion: version, enabled: Type.Boolean(), removed: Type.Boolean(), createdAt: date, updatedAt: date }),
  account: object({ accountId: id, serviceId: id, revision, label: Type.String({ minLength: 1, maxLength: 128 }), credentialRef: nullable(id),
    auth: enumeration(['none', 'bearer', 'oauth']), state: enumeration(['unconfigured', 'ready', 'login-required', 'refresh-required', 'revoked']), createdAt: date, updatedAt: date }),
  connection: object({ ...binding, connectionId: id, sessionId: id, revision, state: enumeration(['connecting', 'connected', 'disconnected', 'failed', 'closing', 'closed']),
    protocolVersion: nullable(Type.String({ maxLength: 32 })), capabilities: object({ tools: Type.Boolean(), resources: Type.Boolean(), resourceTemplates: Type.Boolean() }), errorCode, updatedAt: date }),
  catalog: object({ ...binding, catalogId: id, revision, version, tools: Type.Array(McpToolSchema, { maxItems: 1000 }),
    resources: Type.Array(object({ ...resource, uri: text }), { maxItems: 1000 }),
    resourceTemplates: Type.Array(object({ ...resource, uriTemplate: text }), { maxItems: 1000 }), discoveredAt: date }),
  classification: object({ ...catalogBinding, classificationId: id, revision, toolId: id, definitionVersion: version,
    effects: McpEffectsSchema, sourceDecisionId: id, confirmedAt: date, revokedAt: nullable(date) }),
  rule: object({ ruleId: id, serviceId: id, revision, target: McpRuleTargetSchema, updatedAt: date }),
  authorization: object({ requestId: id, operation: object({ serviceName: text, source: text, transport: McpTransportSchema, accountLabel: text, toolName: text }), revision, identity: McpOperationIdentitySchema, argumentsFingerprint: version, arguments: data,
    effects: McpEffectsSchema, status: enumeration(['pending', 'allowed', 'denied', 'expired', 'cancelled', 'invalidated']), createdAt: date, expiresAt: date, decidedAt: nullable(date), revokedAt: nullable(date) }),
  call: object({ callId: id, revision, identity: McpOperationIdentitySchema, argumentsFingerprint: version, authorizationId: nullable(id),
    state: enumeration(['prepared', 'running', 'succeeded', 'failed', 'cancel-requested', 'cancelled', 'unknown']), errorCode, startedAt: nullable(date), finishedAt: nullable(date), resultRef: nullable(id) }),
  resourceSnapshot: object({ ...catalogBinding, snapshotId: id, revision, sessionId: id, uri: text, mimeType: Type.String({ maxLength: 256 }),
    text: Type.String({ maxLength: 250000 }), truncated: Type.Boolean(), readAt: date }),
  importPreview: object({ previewId: id, revision, name: Type.String({ minLength: 1, maxLength: 128 }), source: text, transport: McpTransportSchema,
    existingServiceId: nullable(id), expectedServiceRevision: nullable(revision), configVersion: version, createdAt: date, expiresAt: date }),
};
