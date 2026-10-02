import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TaskListSchema, TaskReceiptSchema, TaskDetailSchema, type Task, type TaskDetail, type TaskList, type TaskControl, type CreateTask, type UpdateTask } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

interface State { tasks: readonly Task[]; total: number; nextOffset: number | null; loading: boolean; error: string; selected: string | null }
const EMPTY: State = { tasks: [], total: 0, nextOffset: null, loading: false, error: '', selected: null };
export class TasksStore {
  private state: State = EMPTY;
  private listeners = new Set<() => void>();
  private read = 0;
  private loaded = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private replace(state: State) { this.state = state; for (const listener of this.listeners) listener(); }
  select = (selected: string | null) => this.replace({ ...this.state, selected });
  apply = (task: Task) => {
    const before = this.state.tasks.find((item) => item.taskId === task.taskId);
    if (before && before.revision > task.revision) return;
    this.replace({ ...this.state, tasks: [...this.state.tasks.filter((item) => item.taskId !== task.taskId), task].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), total: this.state.total + (before ? 0 : 1) });
  };
  refresh = async (more = false) => {
    const read = ++this.read;
    const offset = more ? this.state.nextOffset : 0;
    if (offset === null) return;
    this.replace({ ...this.state, loading: true, error: '' });
    try {
      const result = await fetchJson<TaskList>(`/api/tasks?limit=100&sort=recent&offset=${offset}`, undefined, TaskListSchema);
      if (read !== this.read) return;
      const newer = new Map(this.state.tasks.map((task) => [task.taskId, task]));
      const tasks = result.tasks.map((task) => { const current = newer.get(task.taskId); return current && current.revision > task.revision ? current : task; });
      const merged = more ? [...this.state.tasks.filter((task) => !tasks.some((item) => item.taskId === task.taskId)), ...tasks] : tasks;
      this.loaded = true; this.replace({ ...this.state, tasks: merged, total: result.total, nextOffset: result.nextOffset, loading: false });
    } catch (failure) { if (read === this.read) this.replace({ ...this.state, loading: false, error: failure instanceof Error ? failure.message : '任务未读取。' }); }
  };
  ensure = () => { if (!this.loaded && !this.state.loading) void this.refresh(); };
  detail = (id: string, before?: number) => fetchJson<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}${before ? `?before=${before}` : ''}`, undefined, TaskDetailSchema);
  create = async (input: CreateTask) => {
    const result = await fetchJson<{ task: Task; commandId: string }>('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, TaskReceiptSchema); this.apply(result.task); return result.task;
  };
  update = async (task: Task, patch: UpdateTask['patch']) => {
    const result = await fetchJson<{ task: Task; commandId: string }>(`/api/tasks/${encodeURIComponent(task.taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: crypto.randomUUID(), revision: task.revision, patch }) }, TaskReceiptSchema); this.apply(result.task); return result.task;
  };
  control = async (task: Task, action: TaskControl['action']) => {
    try {
      const result = await fetchJson<{ task: Task; commandId: string }>(`/api/tasks/${encodeURIComponent(task.taskId)}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: crypto.randomUUID(), revision: task.revision, action }) }, TaskReceiptSchema); this.apply(result.task);
    } finally { const detail = await this.detail(task.taskId); this.apply(detail.task); }
  };
}
const Context = createContext<TasksStore | null>(null);
export function TasksProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TasksStore());
  useWorkbenchEvents((event) => { if (event.type === 'task.changed') store.apply(event.task); if (event.type === 'workbench.connected') store.ensure(); });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTasks() {
  const store = useContext(Context);
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), store?.snapshot ?? (() => EMPTY));
  return { ...state, store };
}
