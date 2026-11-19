import { satisfiesTaskDependency, type Task, type TaskReviewItem } from '@multivac/contracts';
import type { TaskFacts } from '../modules/tasks/task-facts.js';
import { TaskServiceError } from '../modules/tasks/task-error.js';
import type { TaskService } from './task-service.js';

function ancestorRoot(tasks: TaskService, task: Task): Task {
  let root = task;
  while (root.parentTaskId) root = tasks.get(root.parentTaskId);
  return root;
}

/** 多层任务只向最上层汇总。顶层已结束、由用户处理或本轮未纳入时，子项走自己的验收。 */
export function inheritsTaskReview(tasks: TaskService, facts: TaskFacts, task: Task): boolean {
  if (task.acceptanceMode !== 'top-level' || task.humanOnly || !task.parentTaskId) return false;
  const root = ancestorRoot(tasks, task);
  if (root.humanOnly || root.status === 'done' || root.status === 'cancelled') return false;
  const run = root.currentRunId ? facts.runs.get(root.currentRunId) : null;
  return !run || (run.treeTasks ?? []).some(item => item.taskId === task.taskId);
}

export function assertChildReviewIsEditable(tasks: TaskService, facts: TaskFacts, child: Task): void {
  if (child.acceptanceMode !== 'top-level') return;
  const root = ancestorRoot(tasks, child);
  if (facts.requests.list(root.taskId).some(request => request.status === 'pending' && request.reviewItems?.some(item => item.taskId === child.taskId))) {
    throw new TaskServiceError('INVALID_REQUEST', '子任务成果已随顶层任务提交验收。需先处理整体验收请求。');
  }
}

function reviewItem(tasks: TaskService, facts: TaskFacts, child: Task): TaskReviewItem {
  const blocked = (reason: string): never => {
    throw new TaskServiceError('INVALID_REQUEST', `子任务「${child.title}」${reason}`);
  };
  if (child.status !== 'review') blocked(`尚未交付。${child.reason}`);
  if (tasks.pendingRequest(child.taskId)) blocked('仍有待处理请求。');
  if (child.dependencyIds.some(id => !satisfiesTaskDependency(tasks.get(id).status))) blocked('的前置任务尚未满足条件。');
  const base = { taskId: child.taskId, title: child.title };
  if (child.completionReport && !child.currentRunId) {
    return { ...base, kind: 'completion-report', report: child.completionReport, requiresJudgment: true };
  }
  const version = child.artifactVersionId ? facts.artifacts.get(child.artifactVersionId) : null;
  const run = version ? facts.runs.get(version.runId) : null;
  if (!version || version.status !== 'submitted' || !run?.stopConfirmed || run.status !== 'settled' || child.currentRunId !== run.runId) {
    return blocked('没有已固定且可验收的成果。');
  }
  if (version.checks.some(check => !check.passed)) return blocked('的成果自检未通过。');
  const requiresJudgment = run.toolFailures > 0 || !version.checks.some(check => check.name === child.acceptanceCriteria && check.passed);
  return { ...base, kind: 'artifact', versionId: version.versionId, requiresJudgment };
}

export function collectTaskReviewItems(tasks: TaskService, facts: TaskFacts, task: Task, scope?: readonly Task[]): TaskReviewItem[] {
  if (task.parentTaskId || task.humanOnly) return [];
  return (scope ?? tasks.descendants(task.taskId)).map(item => tasks.get(item.taskId))
    .filter(child => child.acceptanceMode === 'top-level' && !child.humanOnly && child.status !== 'done' && child.status !== 'cancelled')
    .map(child => reviewItem(tasks, facts, child));
}

/** 复核请求内固定的版本和门禁，然后在同一事务内保存每个子项的决定。 */
export function applyTaskReviewItems(tasks: TaskService, facts: TaskFacts, items: readonly TaskReviewItem[], decision: {
  id: string; rootTaskId: string; accept: boolean; feedback: string; automatic?: boolean;
}, changed: Task[]): void {
  for (const item of items) {
    const task = tasks.get(item.taskId);
    if (task.acceptanceMode !== 'top-level' || ancestorRoot(tasks, task).taskId !== decision.rootTaskId) {
      throw new TaskServiceError('TASK_CONFLICT', '子任务验收归属已变化，请重新核对。');
    }
    const current = reviewItem(tasks, facts, task);
    const same = item.kind === 'artifact'
      ? current.kind === 'artifact' && item.versionId === current.versionId
      : current.kind === 'completion-report' && item.report.reportId === current.report.reportId;
    if (!same || item.requiresJudgment !== current.requiresJudgment) throw new TaskServiceError('TASK_CONFLICT', '子任务成果或验证记录已变化，请重新核对。');
    if (item.kind === 'artifact') {
      const version = facts.artifacts.get(item.versionId)!;
      facts.artifacts.save({ ...version, status: decision.accept ? 'accepted' : 'changes', feedback: decision.feedback });
    }
    changed.push(tasks.saveReviewChild(facts, task, decision.accept ? {
      status: 'done', completedAt: new Date().toISOString(), pauseSource: null,
      reason: decision.automatic ? '子任务成果随顶层任务通过服务端自检。' : '子任务成果已随顶层任务验收。', nextStep: '查看成果。',
    } : {
      status: 'paused', pauseSource: 'user', feedback: decision.feedback, completedAt: null,
      reason: '顶层验收已退回本次子任务成果。', nextStep: '按修改意见重新提交成果。',
    }, decision.id));
  }
}
