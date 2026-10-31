import { Type } from 'typebox';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
const Text = Type.String({ minLength: 1, maxLength: 16000 });
const Time = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
export const ScheduleRuleSchema = Type.Union([
  Type.Object({ kind: Type.Literal('once'), scheduledAt: Type.String(), localTime: Type.String() }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('daily'), time: Time }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('weekly'), time: Time, days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }) }, { additionalProperties: false }),
]);
export type ScheduleRule = Type.Static<typeof ScheduleRuleSchema>;
export const ScheduleBudgetSchema = Type.Object({
  maxMillis: Type.Integer({ minimum: 1000, maximum: 86400000 }),
  maxOutputBytes: Type.Integer({ minimum: 1024, maximum: 67108864 }),
  maxToolCalls: Type.Integer({ minimum: 1, maximum: 1000 }),
}, { additionalProperties: false });
export const ScheduleActionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('reminder'), text: Text }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('agent'), instruction: Text, agentId: Id,
    projectId: Type.Union([Id, Type.Null()]), directory: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    budget: ScheduleBudgetSchema,
  }, { additionalProperties: false }),
]);
export type ScheduleAction = Type.Static<typeof ScheduleActionSchema>;
export const ScheduleDraftSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }), action: ScheduleActionSchema, rule: ScheduleRuleSchema,
  timeZone: Type.String({ minLength: 1, maxLength: 100 }), missedPolicy: Type.Union([Type.Literal('skip'), Type.Literal('latest')]),
}, { additionalProperties: false });
export type ScheduleDraft = Type.Static<typeof ScheduleDraftSchema>;
export const CreateScheduleSchema = Type.Object({ commandId: Id, ...ScheduleDraftSchema.properties }, { additionalProperties: false });
export const UpdateScheduleSchema = Type.Object({ commandId: Id, scheduleId: Id, revision: Type.Integer({ minimum: 1 }), ...ScheduleDraftSchema.properties }, { additionalProperties: false });
export const ControlScheduleSchema = Type.Object({ commandId: Id, scheduleId: Id, revision: Type.Integer({ minimum: 1 }),
  operation: Type.Union(['pause', 'enable', 'delete', 'trigger', 'stop'].map(value => Type.Literal(value))),
}, { additionalProperties: false });
export type CreateSchedule = Type.Static<typeof CreateScheduleSchema>;
export type UpdateSchedule = Type.Static<typeof UpdateScheduleSchema>;
export type ControlSchedule = Omit<Type.Static<typeof ControlScheduleSchema>, 'operation'> & { operation: 'pause' | 'enable' | 'delete' | 'trigger' | 'stop' };
export interface Schedule extends ScheduleDraft {
  scheduleId: string; revision: number; state: 'active' | 'paused' | 'completed' | 'deleted';
  nextAt: string | null; sourceSessionId: string; createdAt: string; updatedAt: string;
  legacyReminderId: string | null;
}
export type OccurrenceStatus = 'pending' | 'running' | 'waiting' | 'stopping' | 'succeeded' | 'failed' | 'stopped' | 'skipped' | 'reconcile';
export interface ScheduleOccurrence {
  occurrenceId: string; scheduleId: string; scheduleRevision: number; snapshot: Schedule;
  source: 'planned' | 'manual'; plannedAt: string; localTime: string; startedAt: string | null; endedAt: string | null;
  status: OccurrenceStatus; reason: string | null; summary: string | null;
  sessionId: string | null; notificationId: string | null; leaseOwner: string | null; leaseUntil: string | null;
  executionSnapshot: Record<string, unknown> | null;
}
export interface SchedulePreview { scheduledAt: string; localTime: string; skipReason: 'dst-gap' | null }
export interface ScheduleQuery { state?: Schedule['state']; kind?: ScheduleAction['kind']; query?: string; offset?: number; limit?: number }
export interface SchedulePage { items: Schedule[]; total: number; nextOffset: number | null }
export const OCCURRENCE_ACTIVE: readonly OccurrenceStatus[] = ['pending', 'running', 'waiting', 'stopping', 'reconcile'];
export const ScheduleInputRequestSchema = Type.Object({
  requestId: Id, scheduleId: Id, occurrenceId: Id, sessionId: Id, revision: Type.Integer({ minimum: 1 }),
  question: Type.String({ minLength: 1, maxLength: 4000 }), status: Type.Union([Type.Literal('pending'),Type.Literal('answered'),Type.Literal('invalidated')]),
  answer: Type.String({ maxLength: 4000 }), createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false });
export type ScheduleInputRequest = Type.Static<typeof ScheduleInputRequestSchema>;

export const ScheduleQuerySchema = Type.Object({
  state: Type.Optional(Type.Union(['active','paused','completed','deleted'].map(x => Type.Literal(x)))),
  kind: Type.Optional(Type.Union([Type.Literal('reminder'),Type.Literal('agent')])), query: Type.Optional(Type.String({ maxLength: 200 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });

export const ScheduleSchema = Type.Object({ ...ScheduleDraftSchema.properties,
  scheduleId: Id, revision: Type.Integer({ minimum: 1 }), state: Type.Union([Type.Literal('active'),Type.Literal('paused'),Type.Literal('completed'),Type.Literal('deleted')]),
  nextAt: Type.Union([Type.String(),Type.Null()]), sourceSessionId: Id, createdAt: Type.String(), updatedAt: Type.String(), legacyReminderId: Type.Union([Id,Type.Null()]),
}, { additionalProperties: false });
export const ScheduleOccurrenceSchema = Type.Object({
  occurrenceId: Id, scheduleId: Id, scheduleRevision: Type.Integer(), snapshot: ScheduleSchema,
  source: Type.Union([Type.Literal('planned'),Type.Literal('manual')]), plannedAt: Type.String(), localTime: Type.String(),
  startedAt: Type.Union([Type.String(),Type.Null()]), endedAt: Type.Union([Type.String(),Type.Null()]),
  status: Type.Union(['pending','running','waiting','stopping','succeeded','failed','stopped','skipped','reconcile'].map(x => Type.Literal(x))),
  reason: Type.Union([Type.String(),Type.Null()]), summary: Type.Union([Type.String(),Type.Null()]),
  sessionId: Type.Union([Id,Type.Null()]), notificationId: Type.Union([Id,Type.Null()]), leaseOwner: Type.Union([Type.String(),Type.Null()]), leaseUntil: Type.Union([Type.String(),Type.Null()]),
  executionSnapshot: Type.Union([Type.Record(Type.String(),Type.Unknown()),Type.Null()]),
}, { additionalProperties: false });
const NullableOccurrence = Type.Union([ScheduleOccurrenceSchema,Type.Null()]);
const PageFields = { total: Type.Integer({ minimum: 0 }), nextOffset: Type.Union([Type.Integer({ minimum: 0 }),Type.Null()]) };
const LatestOccurrenceSchema = Type.Object({ occurrenceId: Id, status: ScheduleOccurrenceSchema.properties.status, plannedAt: Type.String() }, { additionalProperties: false });
export const SchedulePageSchema = Type.Object({ items: Type.Array(Type.Object({ ...ScheduleSchema.properties, latest: Type.Union([LatestOccurrenceSchema,Type.Null()]) }, { additionalProperties: false })), ...PageFields }, { additionalProperties: false });
export const ScheduleDetailSchema = Type.Object({ schedule: ScheduleSchema, active: NullableOccurrence,
  history: Type.Object({ items: Type.Array(ScheduleOccurrenceSchema), ...PageFields }, { additionalProperties: false }),
  preview: Type.Array(Type.Object({ scheduledAt: Type.String(), localTime: Type.String(), skipReason: Type.Union([Type.Literal('dst-gap'),Type.Null()]) })),
}, { additionalProperties: false });
export type ScheduleDetail = { schedule: Schedule; active: ScheduleOccurrence | null; history: {items: ScheduleOccurrence[]; total: number; nextOffset: number | null}; preview: SchedulePreview[] };
export type ScheduleList = Omit<SchedulePage, 'items'> & { items: (Schedule & {latest: Pick<ScheduleOccurrence, 'occurrenceId' | 'status' | 'plannedAt'> | null})[] };
