import { Type } from 'typebox';
import { TaskSchema, TaskRunSchema } from '@multivac/contracts';

/** 运行页只读取显示事实，任务目标、预算、任务树快照等负载留在详情路径。 */
export const RunOverviewTaskSchema = Type.Pick(TaskSchema, [
  'taskId', 'title', 'revision', 'status', 'reason', 'nextStep', 'deletedAt', 'pauseSource',
]);
export const RunOverviewExecutionSchema = Type.Pick(TaskRunSchema, [
  'runId', 'sessionId', 'status', 'stopConfirmed', 'stopIntent', 'hasStarted',
  'createdAt', 'updatedAt', 'startedAt', 'elapsedMs', 'reason', 'noProgressSince', 'lastTool', 'lastToolAt',
]);
export interface RunOverview {
  version: number;
  rows: {
    task: Type.Static<typeof RunOverviewTaskSchema>;
    run: Type.Static<typeof RunOverviewExecutionSchema> | null;
    sessionAvailable: boolean;
  }[];
}
