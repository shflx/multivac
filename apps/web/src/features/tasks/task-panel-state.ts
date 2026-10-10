import { taskViewStatus, type Task, type HumanRequest } from '@multivac/contracts';
export const TASK_COLUMNS = [
  { id: 'idle', label: '未开始' }, { id: 'running', label: '执行中' }, { id: 'waiting', label: '阻塞' },
  { id: 'review', label: '审核中' }, { id: 'paused', label: '已暂停' }, { id: 'done', label: '已完成' }, { id: 'cancelled', label: '已取消' },
] as const;
export type TaskColumn = typeof TASK_COLUMNS[number]['id'];
export function taskColumn(task: Task, requests: readonly HumanRequest[] = []): TaskColumn {
  return taskViewStatus(task, requests);
}
export function taskLabel(task: Task, requests: readonly HumanRequest[] = []): string {
  if (task.status === 'failed') return '执行失败';
  if (task.status === 'recovery') return '恢复待确认';
  if (task.status === 'queued') return '排队中';
  const pending = requests.filter((request) => request.taskId === task.taskId && request.status === 'pending');
  const request = pending.find((request) => request.kind === 'review') ?? pending[0];
  if (request) return ({ review: '审核中', clarification: '待澄清', recovery: '恢复待确认', authorization: '待授权' })[request.kind];
  if (task.executionTaskId && task.status === 'waiting' && task.executionProgress) {
    return ({ pending: '待处理', processing: '处理中', ready: '已处理，待核对', paused: '待继续' })[task.executionProgress];
  }
  return columnLabel(taskColumn(task, requests));
}
export function columnLabel(id: TaskColumn): string {
  return TASK_COLUMNS.find((column) => column.id === id)!.label;
}
export function splitCompleted(tasks: readonly Task[], now = Date.now()) {
  const completed = tasks.filter((task) => task.status === 'done').sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''));
  const recent = completed.filter((task) => Date.parse(task.completedAt ?? '') >= now - 7 * 86400000).slice(0, 5);
  return { recent, older: completed.filter((task) => !recent.includes(task)) };
}
export function matchesTask(task: Task, query: string, project: string, status: string, requests: readonly HumanRequest[]): boolean {
  const column = taskColumn(task, requests);
  return (project === 'all' || (task.projectId ?? 'daily') === project) && (status === 'all' || (status === 'unfinished' ? !['done', 'cancelled'].includes(column) : column === status)) && (!query.trim() || [task.title, task.goal, task.reason, task.nextStep, task.scope].join('\n').toLowerCase().includes(query.trim().toLowerCase()));
}
export function taskDropAction(task: Task, requests: readonly HumanRequest[], target: TaskColumn): { kind: 'reorder' | 'blocked' | 'request' | 'start' | 'resume' | 'pause' | 'cancel'; label: string } {
  const column = taskColumn(task, requests);
  if (task.executionTaskId && !['done', 'review', 'cancelled'].includes(task.status)) return { kind: 'blocked', label: '由父任务统一执行，请在父任务操作' };
  if (target === column) return { kind: 'reorder', label: '调整呈现顺序' };
  if (target === 'cancelled' && !['done', 'cancelled'].includes(column)) return { kind: 'cancel', label: '取消任务' };
  const request = requests.find((item) => item.taskId === task.taskId && item.status === 'pending');
  if (request) return { kind: 'request', label: request.kind === 'review' ? '打开原成果验收' : '处理原人工请求' };
  if (task.status === 'failed' || task.status === 'recovery') return { kind: 'blocked', label: '先核对阻塞原因' };
  if (task.humanOnly) return { kind: 'blocked', label: '由你处理，请使用“标记完成”确认结果' };
  if (target === 'running' && task.status === 'queued') return { kind: 'blocked', label: '任务已排队，等待依赖与资源后自动开始' };
  if (target === 'running' && task.status === 'idle') return { kind: 'start', label: '启动任务' };
  if (target === 'running' && task.status === 'paused') return { kind: 'resume', label: '继续执行' };
  if (target === 'paused' && column === 'running') return { kind: 'pause', label: '暂停任务' };
  return { kind: 'blocked', label: target === 'done' ? '完成需要真实成果自检或用户验收' : '该状态不能直接改变' };
}
export function reorderTasks(order: readonly string[], members: readonly string[], id: string, beforeId?: string): string[] {
  const ids = [...new Set([...order.filter((item) => members.includes(item)), ...members])];
  if (!members.includes(id) || beforeId === id) return ids;
  const next = ids.filter((item) => item !== id);
  const at = beforeId ? next.indexOf(beforeId) : -1;
  next.splice(at < 0 ? next.length : at, 0, id); return next;
}
