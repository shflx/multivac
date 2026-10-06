/** 原型使用本地任务事实，关系约束与 dev 一致；父子关系不隐含执行依赖。 */
export const isTerminalTask = (task) => ['done', 'cancelled'].includes(task.status);
export const dependencySatisfied = (task) => task && ['review', 'acceptance', 'done'].includes(task.status);
export function unmetDependencies(task, tasks) {
  return (task.dependencyIds || []).filter((id) => !dependencySatisfied(tasks.find((item) => item.id === id)));
}

function reaches(tasks, from, target, edges, visited = new Set()) {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  const task = tasks.find((item) => item.id === from);
  return !!task && edges(task).some((id) => reaches(tasks, id, target, edges, visited));
}

export function relationError(task, patch, tasks) {
  const next = { ...task, ...patch };
  const parent = next.parentTaskId;
  const dependencies = next.dependencyIds || [];
  const related = [parent, ...dependencies].filter(Boolean);
  if (related.includes(next.id)) return '任务不能关联自身。';
  if (related.some((id) => !tasks.some((item) => item.id === id && (item.projectId || null) === (next.projectId || null)))) return '关系已失效或不属于当前项目，请重新选择。';
  if (parent && reaches(tasks, parent, next.id, (item) => item.parentTaskId ? [item.parentTaskId] : [])) return '父子任务不能形成循环。';
  if (dependencies.some((id) => reaches(tasks, id, next.id, (item) => item.dependencyIds || []))) return '前置任务不能形成循环依赖。';
  return '';
}

export function relationEditReason(task, requests = []) {
  if (isTerminalTask(task)) return '已结束任务只读。';
  if (!['idle', 'paused', 'failed'].includes(task.status)) return '请先暂停任务再修改关系。';
  if (requests.some((request) => request.taskId === task.id && request.state !== 'done')) return '请先处理待处理请求。';
  return '';
}

/** 列表保持层级；筛选命中的子任务即使父任务未命中，也能作为根行显示。 */
export function taskTreeRows(visible, tasks, expanded) {
  const ids = new Set(visible.map((task) => task.id));
  const rows = [];
  const visited = new Set();
  const append = (task, depth) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const children = tasks.filter((item) => item.parentTaskId === task.id);
    rows.push({ task, depth, children });
    if (expanded.has(task.id)) children.forEach((child) => append(child, depth + 1));
  };
  visible.filter((task) => !ids.has(task.parentTaskId) || !expanded.has(task.parentTaskId)).forEach((task) => append(task, 0));
  // 损坏的旧关系也不能让整组任务消失。
  visible.forEach((task) => { if (!visited.has(task.id)) append(task, 0); });
  return rows;
}
