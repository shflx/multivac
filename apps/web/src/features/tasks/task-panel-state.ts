import type { Task, HumanRequest } from '@multivac/contracts';
export const TASK_COLUMNS = [
  { id: 'idle', label: '未开始' }, { id: 'running', label: '执行中' }, { id: 'waiting', label: '阻塞' },
  { id: 'review', label: '审核中' }, { id: 'paused', label: '已暂停' }, { id: 'done', label: '已完成' }, { id: 'cancelled', label: '已取消' },
] as const;
export type TaskColumn = typeof TASK_COLUMNS[number]['id'];
export function taskColumn(task: Task, requests: readonly HumanRequest[] = []): TaskColumn {
  if (task.status === 'cancelled' || task.status === 'done') return task.status;
  const pending = requests.find((request) => request.taskId === task.taskId && request.status === 'pending');
  if (pending?.kind === 'review') return 'review';
  if (pending) return 'waiting';
  if (task.status === 'failed' || task.status === 'recovery') return 'waiting';
  if (task.status === 'queued') return 'idle';
  return task.status;
}
export function taskLabel(task: Task, requests: readonly HumanRequest[] = []): string {
  if (task.status === 'failed') return '执行失败';
  if (task.status === 'recovery') return '恢复待确认';
  if (task.status === 'queued') return '排队中';
  const request = requests.find((request) => request.taskId === task.taskId && request.status === 'pending');
  if (request) return ({ review: '待验收', clarification: '待澄清', recovery: '恢复待确认', authorization: '待授权' })[request.kind];
  return TASK_COLUMNS.find((column) => column.id === taskColumn(task, requests))!.label;
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
