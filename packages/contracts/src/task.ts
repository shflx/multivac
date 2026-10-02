import { Type } from 'typebox';
import { WorkingDirectorySchema } from './workspace-session.js';

export const TaskIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const TaskStatusSchema = Type.Union([
  Type.Literal('idle'), Type.Literal('queued'), Type.Literal('running'),
  Type.Literal('waiting'), Type.Literal('review'), Type.Literal('paused'),
  Type.Literal('done'), Type.Literal('cancelled'), Type.Literal('failed'), Type.Literal('recovery'),
]);
export type TaskStatus = Type.Static<typeof TaskStatusSchema>;
const NullableId = Type.Union([TaskIdSchema, Type.Null()]);
const Text = Type.String({ maxLength: 16000 });
const Title = Type.String({ minLength: 1, maxLength: 200 });
const Priority = Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]);
const Dependencies = Type.Array(TaskIdSchema, { maxItems: 100, uniqueItems: true });
const TaskFields = {
  title: Title,
  goal: Type.String({ minLength: 1, maxLength: 16000 }),
  projectId: NullableId,
  scope: Text,
  priority: Priority,
  acceptance: Type.Boolean(),
  acceptanceCriteria: Text,
  groupId: NullableId,
  parentTaskId: NullableId,
  dependencyIds: Dependencies,
};

/** Task 是长期目标；运行引用为空时，不能从目标文字推断执行事实。 */
export const TaskSchema = Type.Object({
  taskId: TaskIdSchema, ...TaskFields,
  status: TaskStatusSchema,
  revision: Type.Integer({ minimum: 1 }),
  sessionId: NullableId,
  currentRunId: NullableId,
  reason: Text,
  nextStep: Text,
  createdAt: Type.String(), updatedAt: Type.String(),
  completedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type Task = Type.Static<typeof TaskSchema>;

export const CreateTaskSchema = Type.Object({
  commandId: TaskIdSchema,
  title: Title, goal: TaskFields.goal,
  projectId: Type.Optional(NullableId), scope: Type.Optional(Text),
  priority: Type.Optional(Priority), acceptance: Type.Optional(Type.Boolean()),
  acceptanceCriteria: Type.Optional(Text), groupId: Type.Optional(NullableId),
  parentTaskId: Type.Optional(NullableId), dependencyIds: Type.Optional(Dependencies),
}, { additionalProperties: false });
export type CreateTask = Type.Static<typeof CreateTaskSchema>;
export const UpdateTaskSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  patch: Type.Partial(Type.Object(TaskFields), { additionalProperties: false, minProperties: 1 }),
}, { additionalProperties: false });
export type UpdateTask = Type.Static<typeof UpdateTaskSchema>;

export const TaskGroupSchema = Type.Object({
  groupId: TaskIdSchema, title: Title, projectId: NullableId, createdAt: Type.String(),
}, { additionalProperties: false });
export type TaskGroup = Type.Static<typeof TaskGroupSchema>;
export const CreateTaskGroupSchema = Type.Object({
  commandId: TaskIdSchema, title: Title, projectId: Type.Optional(NullableId),
}, { additionalProperties: false });
export type CreateTaskGroup = Type.Static<typeof CreateTaskGroupSchema>;

export const TaskQuerySchema = Type.Object({
  projectId: Type.Optional(Type.Union([TaskIdSchema, Type.Literal('daily')])),
  status: Type.Optional(TaskStatusSchema),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  parentTaskId: Type.Optional(TaskIdSchema), dependencyId: Type.Optional(TaskIdSchema),
  groupId: Type.Optional(TaskIdSchema),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type TaskQuery = Type.Static<typeof TaskQuerySchema>;
export const TaskListSchema = Type.Object({
  tasks: Type.Array(TaskSchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type TaskList = Type.Static<typeof TaskListSchema>;
export const TaskEventSchema = Type.Object({
  eventId: Type.Integer({ minimum: 1 }), taskId: TaskIdSchema,
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  kind: Type.String({ minLength: 1, maxLength: 100 }),
  summary: Text, occurredAt: Type.String(),
  task: TaskSchema,
}, { additionalProperties: false });
export type TaskEvent = Type.Static<typeof TaskEventSchema>;
export const TaskReceiptSchema = Type.Object({
  commandId: TaskIdSchema, task: TaskSchema,
}, { additionalProperties: false });
export type TaskReceipt = Type.Static<typeof TaskReceiptSchema>;
export const TaskControlSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  action: Type.Union([Type.Literal('start'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('cancel')]),
}, { additionalProperties: false });
export type TaskControl = Type.Static<typeof TaskControlSchema>;
export const TaskRunSchema = Type.Object({
  runId: TaskIdSchema, taskId: TaskIdSchema, sessionId: TaskIdSchema, commandId: TaskIdSchema,
  status: Type.Union([Type.Literal('preparing'), Type.Literal('running'), Type.Literal('stopping'), Type.Literal('settled'), Type.Literal('failed'), Type.Literal('paused'), Type.Literal('cancelled'), Type.Literal('recovery')]),
  stopIntent: Type.Union([Type.Literal('pause'), Type.Literal('cancel'), Type.Null()]),
  stopConfirmed: Type.Boolean(), ownerId: TaskIdSchema,
  directory: Type.Union([WorkingDirectorySchema, Type.Null()]),
  baseline: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  projectId: NullableId, scope: Text, goal: Text,
  pendingToolIds: Type.Array(TaskIdSchema, { maxItems: 100 }),
  toolFailures: Type.Integer({ minimum: 0 }),
  lastEventCursor: Type.Optional(Type.Integer({ minimum: 0 })),
  piSessionId: NullableId, piEntryId: NullableId,
  reason: Text, createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false });
export type TaskRun = Type.Static<typeof TaskRunSchema>;
export const TaskDetailSchema = Type.Object({
  task: TaskSchema, events: Type.Array(TaskEventSchema, { maxItems: 100 }),
  children: Type.Array(TaskIdSchema, { maxItems: 100 }),
  nextEventBefore: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  totalChildren: Type.Integer({ minimum: 0 }),
  runs: Type.Optional(Type.Array(TaskRunSchema, { maxItems: 100 })),
}, { additionalProperties: false });
export type TaskDetail = Type.Static<typeof TaskDetailSchema>;
