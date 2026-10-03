import { Type } from 'typebox';
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const NullableId = Type.Union([Id, Type.Null()]);
export const HumanRequestKindSchema = Type.Union([Type.Literal('clarification'), Type.Literal('recovery'), Type.Literal('review'), Type.Literal('authorization')]);
export const HumanDecisionSchema = Type.Union([Type.Literal('answer'), Type.Literal('deny'), Type.Literal('continue'), Type.Literal('stop'), Type.Literal('accept'), Type.Literal('changes'), Type.Literal('once'), Type.Literal('session'), Type.Literal('project')]);
export const HumanRequestSchema = Type.Object({
  requestId: Id, taskId: Id, runId: NullableId, sessionId: NullableId,
  kind: HumanRequestKindSchema, revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('answered'), Type.Literal('invalidated')]),
  question: Type.String({ minLength: 1, maxLength: 4000 }),
  artifactVersionId: NullableId, authorizationRequestId: NullableId,
  decision: Type.Union([HumanDecisionSchema, Type.Null()]),
  answer: Type.String({ maxLength: 4000 }), reason: Type.String({ maxLength: 4000 }),
  createdAt: Type.String(), updatedAt: Type.String(),
  stopConfirmed: Type.Optional(Type.Boolean()),
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
