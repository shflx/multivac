import { useEffect, useState } from 'react';
import { Type } from 'typebox';
import { TaskSchema, type Task } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { ObjectLink } from '../assistant/object-links.js';
import { useTasks } from './tasks-provider.js';

const ResponseSchema = Type.Object({ task: TaskSchema }, { additionalProperties: false });
export function SessionTaskLink({ sessionId }: { sessionId: string }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const { store, tasks } = useTasks();
  useEffect(() => {
    let current = true;
    void fetchJson<{ task: Task }>(`/api/task-session/${encodeURIComponent(sessionId)}`, undefined, ResponseSchema).then(({ task }) => { if (current) { store?.apply(task); setTaskId(task.taskId); } }).catch(() => undefined);
    return () => { current = false; };
  }, [sessionId, store]);
  const task = tasks.find((item) => item.taskId === taskId);
  return task ? <div className="session-task-link">关联任务：<ObjectLink target={{ kind: 'task', id: task.taskId }}>{task.title}</ObjectLink><span>{task.reason}</span></div> : null;
}
