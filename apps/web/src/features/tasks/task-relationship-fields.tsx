import { useState } from 'react';
import type { Task } from '@multivac/contracts';
import { useTasks } from './tasks-provider.js';
import { TaskPicker } from './task-picker.js';
import { taskLabel } from './task-panel-state.js';

export function TaskRelationshipFields({ projectId, parentTaskId, dependencyIds, onParent, onDependencies, taskId, disabled = false, parentReason = null }: {
  projectId: string | null; parentTaskId: string | null; dependencyIds: readonly string[];
  onParent: (id: string | null) => void; onDependencies: (ids: string[]) => void;
  taskId?: string; disabled?: boolean; parentReason?: string | null;
}) {
  const { tasks } = useTasks();
  const cache = new Map(tasks.map((task) => [task.taskId, task]));
  const [picker, setPicker] = useState<'parent' | 'dependency' | null>(null);
  const label = (id: string) => {
    const task = cache.get(id);
    return task ? `${task.title} · ${taskLabel(task)}` : `任务已失效或尚未读取（${id}）`;
  };
  const invalid = [parentTaskId, ...dependencyIds].some((id) => id && (!cache.has(id) || cache.get(id)!.projectId !== projectId));
  return <div className="task-relationship-fields">
    <div><h4>父任务</h4><p>{parentTaskId ? label(parentTaskId) : '无父任务'}</p>
      <div className="task-relation-controls"><button type="button" className="inline-link" disabled={disabled || !!parentReason} onClick={() => setPicker('parent')}>{parentTaskId ? '更换父任务' : '选择父任务'}</button>
        {parentTaskId && <button type="button" className="inline-link" disabled={disabled || !!parentReason} onClick={() => onParent(null)}>解除父任务</button>}</div>
      {parentReason && <p className="task-muted">{parentReason}</p>}
    </div>
    <div><h4>前置任务</h4><ul className="task-relation-items">{dependencyIds.map((id) => <li key={id}><span>{label(id)}<small>{id}</small></span><button type="button" className="inline-link" aria-label={`移除前置任务：${cache.get(id)?.title ?? id}`} disabled={disabled} onClick={() => onDependencies(dependencyIds.filter((item) => item !== id))}>移除</button></li>)}</ul>
      {!dependencyIds.length && <p className="task-muted">无前置任务</p>}
      <button type="button" className="inline-link" disabled={disabled || dependencyIds.length >= 100} onClick={() => setPicker('dependency')}>添加前置任务</button>
      <p className="task-muted">所有前置任务完成后才满足执行条件；失败、取消和暂停均不算完成。</p>
    </div>
    {invalid && <p role="alert" className="task-create-error">所选关系已失效或不属于当前项目，请解除后重新选择。</p>}
    {picker && !disabled && !(picker === 'parent' && parentReason) && <TaskPicker key={`${picker}:${projectId}`} label={picker === 'parent' ? '父任务' : '前置任务'} projectId={projectId} relation={picker}
      {...(taskId ? { candidateFor: taskId } : {})} excludeIds={[...(taskId ? [taskId] : []), ...(picker === 'parent' ? parentTaskId ? [parentTaskId] : [] : dependencyIds)]}
      onClose={() => setPicker(null)} onPick={(task: Task) => { if (picker === 'parent') { onParent(task.taskId); setPicker(null); } else onDependencies([...dependencyIds, task.taskId]); }} />}
  </div>;
}
