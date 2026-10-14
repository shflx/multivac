import { Type } from 'typebox';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const ReminderStatusSchema = Type.Union([Type.Literal('scheduled'), Type.Literal('delivered'), Type.Literal('cancelled'), Type.Literal('failed')]);
/** 时间必须同时提供绝对时刻与用户时区下的日历时间，服务端核对二者一致。 */
export const ReminderTimeSchema = Type.Object({
  scheduledAt: Type.String({ minLength: 20, maxLength: 35 }),
  timeZone: Type.String({ minLength: 1, maxLength: 100 }),
  localTime: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$' }),
}, { additionalProperties: false });
export const CreateReminderSchema = Type.Object({
  commandId: Id, text: Type.String({ minLength: 1, maxLength: 4000 }),
  ...ReminderTimeSchema.properties,
}, { additionalProperties: false });
export type CreateReminder = Type.Static<typeof CreateReminderSchema>;
export const UpdateReminderSchema = Type.Object({
  ...CreateReminderSchema.properties, reminderId: Id, revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type UpdateReminder = Type.Static<typeof UpdateReminderSchema>;
export const CancelReminderSchema = Type.Object({
  commandId: Id, reminderId: Id, revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type CancelReminder = Type.Static<typeof CancelReminderSchema>;
export const ReminderQuerySchema = Type.Object({
  status: Type.Optional(ReminderStatusSchema),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type ReminderQuery = Type.Static<typeof ReminderQuerySchema>;
export const ReminderSchema = Type.Object({
  reminderId: Id, revision: Type.Integer({ minimum: 1 }), text: Type.String(),
  ...ReminderTimeSchema.properties, sourceSessionId: Id, status: ReminderStatusSchema,
  createdAt: Type.String(), updatedAt: Type.String(), notificationId: Type.Union([Id, Type.Null()]),
  failure: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type Reminder = Type.Static<typeof ReminderSchema>;
export const InboxNotificationSchema = Type.Object({
  id: Id, reminderId: Id, reminderRevision: Type.Integer({ minimum: 1 }), revision: Type.Integer({ minimum: 1 }),
  text: Type.String(), ...ReminderTimeSchema.properties, sourceSessionId: Id,
  createdAt: Type.String(), acknowledgedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type InboxNotification = Type.Static<typeof InboxNotificationSchema>;

/** 技术定时项只执行注册处理器，不携带模型指令或任意可执行代码。 */
export interface ReminderTimer {
  triggerId: string;
  reminderId: string;
  reminderRevision: number;
  handler: 'inbox-notification';
  dueAt: string;
  state: 'pending' | 'claimed' | 'done' | 'cancelled' | 'failed';
  attempts: number;
  availableAt: string;
  leaseUntil: string | null;
  lastError: string | null;
}
