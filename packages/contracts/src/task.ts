import { Type } from 'typebox';
import { WorkingDirectorySchema } from './workspace-session.js';
import { HumanRequestSchema } from './human-request.js';
import { ArtifactVersionSchema } from './artifact.js';

export const TaskIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' });
export const TaskStatusSchema = Type.Union([
  Type.Literal('idle'), Type.Literal('queued'), Type.Literal('running'),
  Type.Literal('waiting'), Type.Literal('review'), Type.Literal('paused'),
  Type.Literal('done'), Type.Literal('cancelled'), Type.Literal('failed'), Type.Literal('recovery'),
]);
export type TaskStatus = Type.Static<typeof TaskStatusSchema>;
/** 审核中表示已经交付，可放行依赖，但不表示审核通过或子任务已完成。 */
export function satisfiesTaskDependency(status: TaskStatus): boolean {
  return status === 'review' || status === 'done';
}
const NullableId = Type.Union([TaskIdSchema, Type.Null()]);
const Text = Type.String({ maxLength: 16000 });
const Title = Type.String({ minLength: 1, maxLength: 200 });
const Priority = Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]);
const Dependencies = Type.Array(TaskIdSchema, { maxItems: 100, uniqueItems: true });
export const TaskBudgetSchema = Type.Object({
  maxRuns: Type.Integer({ minimum: 1, maximum: 100 }),
  maxMillis: Type.Integer({ minimum: 1000, maximum: 86400000 }),
  maxOutputBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
}, { additionalProperties: false });
export const DEFAULT_TASK_BUDGET = { maxRuns: 20, maxMillis: 900000, maxOutputBytes: 16 * 1024 * 1024 };
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
  budget: Type.Optional(TaskBudgetSchema),
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
  deletedAt: Type.Optional(Type.String()),
  pauseSource: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('human'), Type.Literal('budget'), Type.Literal('environment'), Type.Null()])),
  feedback: Type.Optional(Text),
  artifactVersionId: Type.Optional(NullableId),
  completionReport: Type.Optional(Type.Object({
    reportId: TaskIdSchema, sessionId: TaskIdSchema,
    summary: Type.String({ minLength: 1, maxLength: 3000 }), createdAt: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type Task = Type.Static<typeof TaskSchema>;

export const CreateTaskSchema = Type.Object({
  commandId: TaskIdSchema,
  title: Title, goal: TaskFields.goal,
  projectId: Type.Optional(NullableId), scope: Type.Optional(Text),
  priority: Type.Optional(Priority), acceptance: Type.Optional(Type.Boolean()),
  acceptanceCriteria: Type.Optional(Text), groupId: Type.Optional(NullableId),
  parentTaskId: Type.Optional(NullableId), dependencyIds: Type.Optional(Dependencies),
  budget: Type.Optional(TaskBudgetSchema),
}, { additionalProperties: false });
export type CreateTask = Type.Static<typeof CreateTaskSchema>;
export const TaskProposalPayloadSchema = Type.Omit(CreateTaskSchema, ['commandId'], { additionalProperties: false });
export type TaskProposalPayload = Type.Static<typeof TaskProposalPayloadSchema>;
export const UpdateTaskSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  patch: Type.Partial(Type.Object(TaskFields), { additionalProperties: false, minProperties: 1 }),
}, { additionalProperties: false });
export type UpdateTask = Type.Static<typeof UpdateTaskSchema>;
export const CompleteTaskSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  summary: Type.String({ minLength: 1, maxLength: 3000 }),
}, { additionalProperties: false });
export type CompleteTask = Type.Static<typeof CompleteTaskSchema>;

export const TaskGroupSchema = Type.Object({
  groupId: TaskIdSchema, title: Title, projectId: NullableId, createdAt: Type.String(),
}, { additionalProperties: false });
export type TaskGroup = Type.Static<typeof TaskGroupSchema>;
export const CreateTaskGroupSchema = Type.Object({
  commandId: TaskIdSchema, title: Title, projectId: Type.Optional(NullableId),
}, { additionalProperties: false });
export type CreateTaskGroup = Type.Static<typeof CreateTaskGroupSchema>;

/** 面板状态将排队、失败与人工请求映射到实际展示列，筛选必须在分页前完成。 */
export const TaskViewStatusSchema = Type.Union([
  Type.Literal('idle'), Type.Literal('running'), Type.Literal('waiting'), Type.Literal('review'),
  Type.Literal('paused'), Type.Literal('done'), Type.Literal('cancelled'), Type.Literal('unfinished'),
]);
export type TaskViewStatus = Type.Static<typeof TaskViewStatusSchema>;
export function taskViewStatus(task: Task, requests: readonly Type.Static<typeof HumanRequestSchema>[] = []): Exclude<TaskViewStatus, 'unfinished'> {
  if (task.status === 'done' || task.status === 'cancelled') return task.status;
  const pending = requests.filter((request) => request.taskId === task.taskId && request.status === 'pending');
  if (pending.some((request) => request.kind === 'review')) return 'review';
  if (pending.length || task.status === 'failed' || task.status === 'recovery') return 'waiting';
  return task.status === 'queued' ? 'idle' : task.status;
}

export const TaskQuerySchema = Type.Object({
  ids: Type.Optional(Type.Array(TaskIdSchema, { minItems: 1, maxItems: 100, uniqueItems: true })),
  includeRelations: Type.Optional(Type.Boolean()),
  topLevel: Type.Optional(Type.Boolean()),
  parentCandidateFor: Type.Optional(TaskIdSchema), dependencyCandidateFor: Type.Optional(TaskIdSchema),
  excludeIds: Type.Optional(Type.Array(TaskIdSchema, { maxItems: 101, uniqueItems: true })),
  viewStatus: Type.Optional(TaskViewStatusSchema),
  sort: Type.Optional(Type.Union([Type.Literal('created'), Type.Literal('recent')])),
  projectId: Type.Optional(Type.Union([TaskIdSchema, Type.Literal('daily')])),
  status: Type.Optional(TaskStatusSchema),
  statuses: Type.Optional(Type.Array(TaskStatusSchema, { minItems: 1, maxItems: 10, uniqueItems: true })),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  parentTaskId: Type.Optional(TaskIdSchema), dependencyId: Type.Optional(TaskIdSchema),
  groupId: Type.Optional(TaskIdSchema),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type TaskQuery = Type.Static<typeof TaskQuerySchema>;
export const TaskLinkSchema = Type.Pick(TaskSchema, ['taskId', 'title', 'status', 'revision']);
export const TaskRelationSummarySchema = Type.Object({
  parent: Type.Union([TaskLinkSchema, Type.Null()]),
  children: Type.Object({ total: Type.Integer({ minimum: 0 }), done: Type.Integer({ minimum: 0 }), cancelled: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  // done 字段保留传输兼容，表示满足依赖的数量（review + done），不同于 children.done。
  dependencies: Type.Object({ total: Type.Integer({ minimum: 0 }), done: Type.Integer({ minimum: 0 }), firstUnmet: Type.Union([TaskLinkSchema, Type.Null()]) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRelationSummary = Type.Static<typeof TaskRelationSummarySchema>;
export const TaskRelationsSchema = Type.Object({
  task: TaskSchema, summary: TaskRelationSummarySchema,
  ancestors: Type.Array(TaskSchema, { maxItems: 100 }),
  nextAncestorOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  dependencies: Type.Array(TaskSchema, { maxItems: 100 }), missingDependencyIds: Dependencies,
  editReason: Type.Union([Type.String(), Type.Null()]), parentChangeReason: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type TaskRelations = Type.Static<typeof TaskRelationsSchema>;
export const TaskListSchema = Type.Object({
  relations: Type.Optional(Type.Record(TaskIdSchema, TaskRelationSummarySchema)),
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
export const DeleteTaskSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type DeleteTask = Type.Static<typeof DeleteTaskSchema>;
export const TaskControlSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  action: Type.Union([Type.Literal('start'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('cancel')]),
}, { additionalProperties: false });
export type TaskControl = Type.Static<typeof TaskControlSchema>;
export const TaskRunSchema = Type.Object({
  artifactCandidate: Type.Optional(Type.Object({ commandId: TaskIdSchema, title: Type.String({ minLength: 1, maxLength: 200 }), path: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false })),
  rootTaskId: Type.Optional(TaskIdSchema), ownerPid: Type.Optional(Type.Integer({ minimum: 1 })),
  schedulerManaged: Type.Optional(Type.Boolean()), hasStarted: Type.Optional(Type.Boolean()),
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })), outputBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  startedAt: Type.Optional(Type.String()),
  nativeLeaseFenced: Type.Optional(Type.Boolean()), nativePendingIds: Type.Optional(Type.Array(TaskIdSchema, { maxItems: 100 })),
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
  requests: Type.Optional(Type.Array(HumanRequestSchema, { maxItems: 100 })),
  artifacts: Type.Optional(Type.Array(ArtifactVersionSchema, { maxItems: 100 })),
}, { additionalProperties: false });
export type TaskDetail = Type.Static<typeof TaskDetailSchema>;
