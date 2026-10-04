import { Type } from 'typebox';
import { TaskIdSchema, type Task, type TaskRun } from './task.js';

export const RunDisplayStateSchema = Type.Union([
  Type.Literal('queued'), Type.Literal('preparing'), Type.Literal('running'), Type.Literal('stopping'), Type.Literal('waiting'), Type.Literal('paused'), Type.Literal('budget'), Type.Literal('failed'), Type.Literal('recovery'), Type.Literal('environment'), Type.Literal('settled'),
]);
export type RunDisplayState = Type.Static<typeof RunDisplayStateSchema>;

/** 停止证据优先于任务标签；人工等待和主动暂停不属于异常。 */
export function runDisplayState(task: Task, run: TaskRun | null): RunDisplayState {
  if (run && !run.stopConfirmed) {
    if (run.status === 'recovery' || task.status === 'recovery') return 'recovery';
    if (run.stopIntent || run.status === 'stopping') return 'stopping';
    if (run.hasStarted === false) return 'queued';
    if (run.status === 'preparing') return 'preparing';
    if (run.status === 'running') return 'running';
    return 'recovery';
  }
  if (task.status === 'recovery') return 'recovery';
  if (task.status === 'failed') return 'failed';
  if (task.pauseSource === 'environment') return 'environment';
  if (task.pauseSource === 'budget') return 'budget';
  if (task.status === 'paused') return 'paused';
  if (task.status === 'waiting' || task.status === 'review') return 'waiting';
  if (task.status === 'queued') return 'queued';
  return task.status === 'running' ? 'recovery' : 'settled';
}
export function isRunAnomaly(state: RunDisplayState): boolean {
  return ['failed', 'recovery', 'environment', 'budget'].includes(state);
}
export const RUN_STATE_LABELS: Record<RunDisplayState, string> = {
  queued: '排队中', preparing: '准备中', running: '执行中', stopping: '停止中',
  waiting: '等待用户', paused: '主动暂停', budget: '预算暂停', failed: '执行失败',
  recovery: '恢复核对', environment: '环境停止', settled: '已结束',
};
const NullableText = Type.Union([Type.String(), Type.Null()]);
export const RunSnapshotSchema = Type.Object({
  taskId: TaskIdSchema, runId: Type.Union([TaskIdSchema, Type.Null()]), sessionId: Type.Union([TaskIdSchema, Type.Null()]),
  title: Type.String({ maxLength: 200 }), revision: Type.Integer({ minimum: 1 }),
  state: RunDisplayStateSchema, anomaly: Type.Boolean(), reason: Type.String({ maxLength: 16000 }),
  nextStep: Type.String({ maxLength: 16000 }), startedAt: NullableText, endedAt: NullableText,
  elapsedMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  lastTool: NullableText, lastToolAt: NullableText, canPause: Type.Boolean(),
  taskAvailable: Type.Boolean(), sessionAvailable: Type.Boolean(),
}, { additionalProperties: false });
export type RunSnapshot = Type.Static<typeof RunSnapshotSchema>;
export const RunsQuerySchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, { additionalProperties: false });
export type RunsQuery = Type.Static<typeof RunsQuerySchema>;
export const RunsSnapshotSchema = Type.Object({
  version: Type.Integer({ minimum: 0 }), observedAt: Type.String(),
  items: Type.Array(RunSnapshotSchema, { maxItems: 100 }), total: Type.Integer({ minimum: 0 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  counts: Type.Object({ running: Type.Integer({ minimum: 0 }), queued: Type.Integer({ minimum: 0 }), anomalies: Type.Integer({ minimum: 0 }), waiting: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type RunsSnapshot = Type.Static<typeof RunsSnapshotSchema>;
export function runIndicatorState(counts: RunsSnapshot['counts']): 'idle' | 'ok' | 'attention' {
  return counts.anomalies ? 'attention' : counts.running || counts.queued ? 'ok' : 'idle';
}

export const ManagedProcessSchema = Type.Object({
  processId: TaskIdSchema, taskId: TaskIdSchema, runId: TaskIdSchema, sessionId: TaskIdSchema,
  revision: Type.Integer({ minimum: 1 }), name: Type.String({ maxLength: 200 }), command: Type.String({ maxLength: 1000 }),
  state: Type.Union([Type.Literal('starting'), Type.Literal('running'), Type.Literal('stopping'), Type.Literal('exited'), Type.Literal('failed'), Type.Literal('recovery')]),
  requiredWhileRunning: Type.Boolean(), startedAt: NullableText, endedAt: NullableText,
  port: Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]), reason: Type.String({ maxLength: 2000 }),
}, { additionalProperties: false });
export type ManagedProcess = Type.Static<typeof ManagedProcessSchema>;
export const ManagedStartSchema = Type.Object({
  commandId: TaskIdSchema, name: Type.String({ minLength: 1, maxLength: 200 }),
  script: Type.String({ minLength: 1, maxLength: 1024 }),
  port: Type.Union([Type.Integer({ minimum: 1024, maximum: 65535 }), Type.Null()]), requiredWhileRunning: Type.Boolean(),
}, { additionalProperties: false });
export const ProcessStopSchema = Type.Object({
  commandId: TaskIdSchema, revision: Type.Integer({ minimum: 1 }),
  taskRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), confirmed: Type.Boolean(),
}, { additionalProperties: false });
export type ProcessStop = Type.Static<typeof ProcessStopSchema>;
export const ProcessPreviewSchema = Type.Object({
  process: ManagedProcessSchema, taskRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  needsConfirmation: Type.Boolean(), impact: Type.String(),
}, { additionalProperties: false });
export type ProcessPreview = Type.Static<typeof ProcessPreviewSchema>;

/** 进程独立于单轮 Run；只有显式依赖的进程随任务控制收敛。 */
export function managedProcessLifecycle(action: 'pause' | 'cancel' | 'complete' | 'service-exit' | 'tab-close', required: boolean): 'stop' | 'retain' {
  if (action === 'tab-close') return 'retain';
  if (action === 'service-exit') return 'stop';
  return required ? 'stop' : 'retain';
}
