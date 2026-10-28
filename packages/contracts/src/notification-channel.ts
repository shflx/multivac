import { Type } from 'typebox';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const NullableTime = Type.Union([Type.String(), Type.Null()]);
/** 本地外发期限已由用户确认；不表示任何渠道的会话凭据有效期。 */
export const NOTIFICATION_DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const NotificationDeliveryStateSchema = Type.Union([
  Type.Literal('pending'), Type.Literal('waiting'), Type.Literal('sending'), Type.Literal('accepted'),
  Type.Literal('unknown'), Type.Literal('failed'), Type.Literal('cancelled'), Type.Literal('expired'),
]);
export type NotificationDeliveryState = Type.Static<typeof NotificationDeliveryStateSchema>;
export const NotificationContentSchema = Type.Object({
  notificationId: Id, text: Type.String(), scheduledAt: Type.String(), timeZone: Type.String(),
  localTime: Type.String(), createdAt: Type.String(),
}, { additionalProperties: false });
export type NotificationContent = Type.Static<typeof NotificationContentSchema>;
/** 公开配置只含状态；凭据及私有存储引用均不进入 DTO。 */
export const NotificationChannelSchema = Type.Object({
  id: Id, type: Id, enabled: Type.Boolean(), version: Type.Integer({ minimum: 1 }),
  bindingGeneration: Type.Integer({ minimum: 1 }), scope: Type.Literal('notification'),
  readiness: Type.Union([Type.Literal('ready'), Type.Literal('waiting'), Type.Literal('invalid')]),
  diagnostic: Type.Union([Type.String(), Type.Null()]),
  testedDeliveryId: Type.Union([Id, Type.Null()]), receivedConfirmedAt: NullableTime,
}, { additionalProperties: false });
export type NotificationChannel = Type.Static<typeof NotificationChannelSchema>;
export const NotificationDeliverySchema = Type.Object({
  id: Id, kind: Type.Union([Type.Literal('notification'), Type.Literal('test')]),
  notificationId: Type.Union([Id, Type.Null()]), channelId: Id,
  configVersion: Type.Integer({ minimum: 1 }), bindingGeneration: Type.Integer({ minimum: 1 }),
  state: NotificationDeliveryStateSchema, localMessageId: Id,
  serverMessageId: Type.Union([Type.String(), Type.Null()]), attempts: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(), expiresAt: Type.String(), nextAttemptAt: Type.String(),
  startedAt: NullableTime, completedAt: NullableTime, diagnostic: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type NotificationDelivery = Type.Static<typeof NotificationDeliverySchema>;
export const NotificationChannelListSchema = Type.Object({ items: Type.Array(NotificationChannelSchema) }, { additionalProperties: false });
export const NotificationDeliveryPageSchema = Type.Object({
  items: Type.Array(NotificationDeliverySchema), total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer(), Type.Null()]),
}, { additionalProperties: false });
export const NotificationChannelOperationSchema = Type.Object({
  state: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('unknown')]),
}, { additionalProperties: false });
export type NotificationChannelOperation = Type.Static<typeof NotificationChannelOperationSchema>;
export const SetNotificationChannelSchema = Type.Object({
  commandId: Id, version: Type.Integer({ minimum: 1 }), enabled: Type.Boolean(),
}, { additionalProperties: false });
export const TestNotificationChannelSchema = Type.Object({ commandId: Id, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const ConfirmNotificationTestSchema = Type.Object({
  commandId: Id, version: Type.Integer({ minimum: 1 }), deliveryId: Id, received: Type.Literal(true),
}, { additionalProperties: false });
export const NotificationDeliveryQuerySchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
