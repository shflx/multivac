import { Type } from 'typebox';
import { HumanRequestSchema } from './human-request.js';
import { ToolAuthorizationRequestSchema } from './tool-authorization.js';
import { ExternalOperationSchema } from './external-operation.js';

const Id = Type.String({ minLength: 1, maxLength: 512 });
const NullableId = Type.Union([Id, Type.Null()]);
export const InboxKindSchema = Type.Union([Type.Literal('clarification'), Type.Literal('authorization'), Type.Literal('external'), Type.Literal('review'), Type.Literal('recovery')]);
export const InboxStateSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }), seen: Type.Boolean(), draft: Type.String({ maxLength: 4000 }),
}, { additionalProperties: false });
export type InboxState = Type.Static<typeof InboxStateSchema>;
export const InboxItemSchema = Type.Object({
  id: Id, kind: InboxKindSchema, revision: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('answered'), Type.Literal('invalidated'), Type.Literal('expired'), Type.Literal('unknown')]),
  title: Type.String(), createdAt: Type.String(), updatedAt: Type.String(), blocksWork: Type.Boolean(),
  taskId: NullableId, sessionId: NullableId, artifactVersionId: NullableId,
  human: Type.Union([HumanRequestSchema, Type.Null()]),
  authorization: Type.Union([ToolAuthorizationRequestSchema, Type.Null()]),
  external: Type.Optional(ExternalOperationSchema),
  state: InboxStateSchema,
}, { additionalProperties: false });
export type InboxItem = Type.Static<typeof InboxItemSchema>;
export const InboxQuerySchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('all')])),
  taskId: Type.Optional(Id),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type InboxQuery = Type.Static<typeof InboxQuerySchema>;
export const InboxListSchema = Type.Object({
  items: Type.Array(InboxItemSchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }),
  pendingCount: Type.Integer({ minimum: 0 }), unseenCount: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type InboxList = Type.Static<typeof InboxListSchema>;
export const UpdateInboxStateSchema = Type.Object({
  revision: Type.Integer({ minimum: 0 }), seen: Type.Optional(Type.Literal(true)),
  draft: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false });
export type UpdateInboxState = Type.Static<typeof UpdateInboxStateSchema>;

/** 查看不改变待处理事实；稳定身份作为同时间请求的最后排序键。 */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  return Number(b.blocksWork) - Number(a.blocksWork) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
