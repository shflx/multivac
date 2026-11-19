import { createHash } from 'node:crypto';
import type { Task } from '@multivac/contracts';

/** 人工继续只适用于保存决定时的执行边界；说明、停止结算及请求版本变化不改变该边界。 */
export function humanResumeBoundary(task: Task): string {
  return createHash('sha256').update(JSON.stringify([
    task.goal, task.scope, task.projectId, task.parentTaskId, task.dependencyIds,
    task.agentId, task.skill, task.humanOnly, task.acceptance, task.acceptanceCriteria, task.budget,
    ...(task.acceptanceMode ? [task.acceptanceMode] : []),
  ])).digest('hex');
}
