import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TaskListSchema, TaskReceiptSchema, TaskDetailSchema, type Task, type TaskDetail, type TaskList, type TaskControl, type CreateTask, type UpdateTask, type TaskQuery } from '@multivac/contracts';
import { AssistantApiError, fetchJson } from '../../data/assistant-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { matchesTask } from './task-panel-state.js';

type PanelFilter = Pick<TaskQuery, 'query' | 'projectId' | 'viewStatus'>;
interface State { tasks: readonly Task[]; panelIds: readonly string[]; total: number; nextOffset: number | null; loading: boolean; error: string; selected: string | null; openVersion: number }
const EMPTY: State = { tasks: [], panelIds: [], total: 0, nextOffset: null, loading: false, error: '', selected: null, openVersion: 0 };
export class TasksStore {
  private state: State = EMPTY;
  private listeners = new Set<() => void>();
  private read = 0;
  private loaded = false;
  private filter: PanelFilter = {};
  private windowSize = 100;
  private scheduled = false;
  private refreshAgain = false;
  private readonly deleted = new Set<string>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private replace(state: State) { this.state = state; for (const listener of this.listeners) listener(); }
  private matches(task: Task, requests: TaskDetail['requests'] = []) {
    return matchesTask(task, this.filter.query ?? '', this.filter.projectId ?? 'all', this.filter.viewStatus ?? 'all', requests ?? []);
  }
  // 查询只保存面板成员 ID；对象链接、会话与面板始终使用同一份任务缓存。
  setFilter = (filter: PanelFilter) => {
    const next: PanelFilter = {};
    if (filter.query?.trim()) next.query = filter.query.trim();
    if (filter.projectId) next.projectId = filter.projectId;
    if (filter.viewStatus) next.viewStatus = filter.viewStatus;
    if (JSON.stringify(next) === JSON.stringify(this.filter)) return;
    this.filter = next;
    this.windowSize = 100;
    this.loaded = false;
    void this.refresh();
  };
  reconcile = () => {
    if (this.state.loading) { this.refreshAgain = true; return; }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; void this.refresh(); });
  };
  select = (selected: string | null) => this.replace({ ...this.state, selected: selected && this.deleted.has(selected) ? null : selected });
  open = async (id: string) => {
    const detail = await this.detail(id);
    if (this.deleted.has(id)) throw new AssistantApiError('NOT_FOUND', '任务已删除。', 404);
    this.setFilter({});
    this.apply(detail.task);
    this.replace({ ...this.state, selected: id, openVersion: this.state.openVersion + 1 });
  };
  load = async (id: string) => { const detail = await this.detail(id); if (this.deleted.has(id)) throw new AssistantApiError('NOT_FOUND', '任务已删除。', 404); this.apply(detail.task); return detail.task; };
  apply = (task: Task) => {
    if (this.deleted.has(task.taskId)) return;
    const before = this.state.tasks.find((item) => item.taskId === task.taskId);
    if (before && before.revision > task.revision) return;
    if (task.deletedAt) {
      const wasLoading = this.state.loading;
      const listed = this.state.panelIds.includes(task.taskId);
      this.deleted.add(task.taskId);
      ++this.read;
      this.replace({
        ...this.state, tasks: this.state.tasks.filter((item) => item.taskId !== task.taskId),
        panelIds: this.state.panelIds.filter((id) => id !== task.taskId),
        total: Math.max(0, this.state.total - (this.matches(task) ? 1 : 0)), loading: false,
        selected: this.state.selected === task.taskId ? null : this.state.selected,
        nextOffset: this.state.nextOffset === null ? null : Math.max(0, this.state.nextOffset - (listed ? 1 : 0)),
      });
      if (wasLoading) void this.refresh();
      return;
    }
    const listed = this.state.panelIds.includes(task.taskId);
    const include = listed || this.matches(task);
    this.replace({ ...this.state,
      tasks: [...this.state.tasks.filter((item) => item.taskId !== task.taskId), task].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      panelIds: include && !listed ? [...this.state.panelIds, task.taskId] : this.state.panelIds,
      total: this.state.total + (!before && include ? 1 : 0),
    });
  };
  refresh = async (more = false, resetCache = false) => {
    const read = ++this.read;
    let offset = more ? this.state.nextOffset : 0;
    if (offset === null) return;
    this.replace({ ...this.state, loading: true, error: '' });
    try {
      const received: Task[] = [];
      let result: TaskList;
      let pages = more ? 1 : Math.ceil(this.windowSize / 100);
      do {
        const params = new URLSearchParams({ limit: '100', sort: 'recent', offset: String(offset), ...this.filter });
        result = await fetchJson<TaskList>(`/api/tasks?${params}`, undefined, TaskListSchema);
        if (read !== this.read) return;
        received.push(...result.tasks);
        offset = result.nextOffset;
        pages--;
      } while (offset !== null && pages > 0);
      const newer = new Map(this.state.tasks.map((task) => [task.taskId, task]));
      const tasks = received.filter((task) => !this.deleted.has(task.taskId)).map((task) => {
        const current = newer.get(task.taskId);
        return current && current.revision > task.revision ? current : task;
      });
      const ids = new Set(more ? this.state.panelIds : []);
      for (const task of tasks) ids.add(task.taskId);
      let selectedCleared: string | null = null;
      let selected = this.state.selected;
      while (!more && selected && !ids.has(selected)) {
        const lookup = selected;
        // 核对期间仍可切换任务；只保留最后选中的对象，迟到详情不能夺回选中。
        try {
          const detail = await this.detail(lookup);
          if (read !== this.read) return;
          if (this.state.selected !== lookup) { selected = this.state.selected; continue; }
          const current = this.state.tasks.find((task) => task.taskId === lookup);
          const task = current && current.revision > detail.task.revision ? current : detail.task;
          tasks.push(task);
          if (this.matches(task, detail.requests)) ids.add(lookup);
          else selectedCleared = lookup;
        } catch (failure) {
          if (!(failure instanceof AssistantApiError) || failure.code !== 'NOT_FOUND') throw failure;
          if (read !== this.read) return;
          this.deleted.add(lookup);
          if (this.state.selected !== lookup) { selected = this.state.selected; continue; }
          selectedCleared = lookup;
        }
        break;
      }
      const latest = new Map(this.state.tasks.map((task) => [task.taskId, task]));
      const cache = new Map(resetCache ? [] : latest);
      for (const task of tasks) {
        const current = latest.get(task.taskId);
        cache.set(task.taskId, current && current.revision > task.revision ? current : task);
      }
      for (const id of this.deleted) { cache.delete(id); ids.delete(id); }
      this.loaded = true;
      if (more) this.windowSize = Math.max(this.windowSize, (this.state.nextOffset ?? 0) + 100);
      this.replace({ ...this.state, tasks: [...cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId)), panelIds: [...ids], total: result.total, nextOffset: result.nextOffset, loading: false,
        selected: this.state.selected === selectedCleared || (this.state.selected && this.deleted.has(this.state.selected)) ? null : this.state.selected });
    } catch (failure) {
      if (read === this.read) this.replace({ ...this.state, loading: false, error: failure instanceof Error ? failure.message : '任务未读取。' });
    } finally {
      if (read === this.read && this.refreshAgain) { this.refreshAgain = false; this.reconcile(); }
    }
  };
  ensure = () => { if (!this.loaded && !this.state.loading) void this.refresh(); };
  detail = (id: string, before?: number) => fetchJson<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}${before ? `?before=${before}` : ''}`, undefined, TaskDetailSchema);
  create = async (input: CreateTask) => {
    const result = await fetchJson<{ task: Task; commandId: string }>('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, TaskReceiptSchema); this.apply(result.task); return result.task;
  };
  update = async (task: Task, patch: UpdateTask['patch']) => {
    const result = await fetchJson<{ task: Task; commandId: string }>(`/api/tasks/${encodeURIComponent(task.taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: crypto.randomUUID(), revision: task.revision, patch }) }, TaskReceiptSchema); this.apply(result.task); return result.task;
  };
  remove = async (task: Task, commandId = crypto.randomUUID()) => {
    const result = await fetchJson<{ task: Task; commandId: string }>(`/api/tasks/${encodeURIComponent(task.taskId)}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId, revision: task.revision }),
    }, TaskReceiptSchema);
    this.apply(result.task);
    return result.task;
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
  useEffect(() => { store.ensure(); }, [store]);
  useWorkbenchEvents((event) => {
    if (event.type === 'task.changed') { store.apply(event.task); store.reconcile(); }
    if (event.type === 'request.changed') store.reconcile();
    if (event.type === 'workbench.connected') void store.refresh(false, true);
  });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTasks() {
  const store = useContext(Context);
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), store?.snapshot ?? (() => EMPTY));
  return { ...state, store };
}
