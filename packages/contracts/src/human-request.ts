import { Type } from 'typebox';
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const NullableId = Type.Union([Id, Type.Null()]);
export const HumanRequestKindSchema = Type.Union([Type.Literal('clarification'), Type.Literal('recovery'), Type.Literal('review'), Type.Literal('authorization')]);
export const HumanDecisionSchema = Type.Union([Type.Literal('answer'), Type.Literal('use_scope'), Type.Literal('deny'), Type.Literal('continue'), Type.Literal('restart'), Type.Literal('stop'), Type.Literal('accept'), Type.Literal('changes'), Type.Literal('once'), Type.Literal('session'), Type.Literal('project')]);
export const ClarificationScopeSchema = Type.Object({
  materials: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 10 }),
  scope: Type.String({ minLength: 1, maxLength: 1000 }), purpose: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });
export type ClarificationScope = Type.Static<typeof ClarificationScopeSchema>;
export const HumanRequestSchema = Type.Object({
  requestId: Id, taskId: Id, runId: NullableId, sessionId: NullableId,
  kind: HumanRequestKindSchema, revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('answered'), Type.Literal('invalidated')]),
  question: Type.String({ minLength: 1, maxLength: 4000 }),
  artifactVersionId: NullableId, authorizationRequestId: NullableId,
  completionReportId: Type.Optional(Id),
  decision: Type.Union([HumanDecisionSchema, Type.Null()]),
  answer: Type.String({ maxLength: 4000 }), reason: Type.String({ maxLength: 4000 }),
  createdAt: Type.String(), updatedAt: Type.String(),
  clarificationScope: Type.Optional(ClarificationScopeSchema),
  stopConfirmed: Type.Optional(Type.Boolean()),
  recovery: Type.Optional(Type.Object({ canResume: Type.Boolean(), reason: Type.String(), checkpoint: Type.Union([Id, Type.Null()]), pendingTools: Type.Integer({ minimum: 0 }), directory: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type HumanRequest = Type.Static<typeof HumanRequestSchema>;
export const AskTaskInputSchema = Type.Object({ commandId: Id, question: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false });
export const DecideHumanRequestSchema = Type.Object({
  commandId: Id, revision: Type.Integer({ minimum: 1 }), decision: HumanDecisionSchema,
  answer: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false });
export type DecideHumanRequest = Type.Static<typeof DecideHumanRequestSchema>;

/** 传输按页读取；业务门禁读取完整待处理事实，不能依赖最近一页。 */
export const HumanRequestQuerySchema = Type.Object({
  taskId: Type.Optional(Id),
  status: Type.Optional(HumanRequestSchema.properties.status),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type HumanRequestQuery = Type.Static<typeof HumanRequestQuerySchema>;
export const HumanRequestListSchema = Type.Object({
  requests: Type.Array(HumanRequestSchema, { maxItems: 100 }),
  total: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type HumanRequestList = Type.Static<typeof HumanRequestListSchema>;
