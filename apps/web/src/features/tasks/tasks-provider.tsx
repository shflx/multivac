import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TaskListSchema, TaskReceiptSchema, TaskDetailSchema, TaskRelationsSchema, type TaskRelations, type TaskRelationSummary, type Task, type TaskDetail, type TaskList, type TaskControl, type CreateTask, type UpdateTask, type TaskQuery } from '@multivac/contracts';
import { AssistantApiError, fetchJson } from '../../data/assistant-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { matchesTask } from './task-panel-state.js';

type PanelFilter = Pick<TaskQuery, 'query' | 'projectId' | 'viewStatus'>;
interface State { relationVersion: number; relations: Readonly<Record<string, TaskRelationSummary>>; tasks: readonly Task[]; panelIds: readonly string[]; total: number; nextOffset: number | null; loading: boolean; error: string; selected: string | null; openVersion: number }
const EMPTY: State = { relationVersion: 0, relations: {}, tasks: [], panelIds: [], total: 0, nextOffset: null, loading: false, error: '', selected: null, openVersion: 0 };
export class TasksStore {
  private state: State = EMPTY;
  private listeners = new Set<() => void>();
  private read = 0;
  private opening = 0;
  private relationRead = 0;
  private readonly summaryReads = new Map<string, number>();
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
  select = (selected: string | null) => { ++this.opening; this.replace({ ...this.state, selected: selected && this.deleted.has(selected) ? null : selected }); };
  open = async (id: string) => {
    const opening = ++this.opening;
    const detail = await this.detail(id);
    if (opening !== this.opening) return;
    if (this.deleted.has(id)) throw new AssistantApiError('NOT_FOUND', '任务已删除。', 404);
    this.setFilter({});
    this.apply(detail.task);
    this.replace({ ...this.state, selected: id, openVersion: this.state.openVersion + 1 });
  };
  load = async (id: string) => { const detail = await this.detail(id); if (this.deleted.has(id)) throw new AssistantApiError('NOT_FOUND', '任务已删除。', 404); this.apply(detail.task); return detail.task; };
  /** 关系读取只合并共享对象与聚合事实，不触碰主面板成员、数量或分页。 */
  cache = (tasks: readonly Task[], relations: Record<string, TaskRelationSummary> = {}, version = this.state.relationVersion, read = ++this.relationRead) => {
    const cache = new Map(this.state.tasks.map((task) => [task.taskId, task]));
    for (const task of tasks) {
      if (this.deleted.has(task.taskId) || task.deletedAt) continue;
      const previous = cache.get(task.taskId);
      if (!previous || previous.revision <= task.revision) cache.set(task.taskId, task);
    }
    const accepted = Object.fromEntries(Object.entries(relations).filter(([id]) => {
      const received = tasks.find((task) => task.taskId === id);
      return !this.deleted.has(id) && (!received || received.revision >= (cache.get(id)?.revision ?? 0));
    }));
    this.replace({ ...this.state, tasks: [...cache.values()], relations: this.mergeRelations(accepted, version, read) });
  };
  private mergeRelations(relations: Record<string, TaskRelationSummary>, version: number, read: number) {
    if (version !== this.state.relationVersion) return this.state.relations;
    const next = { ...this.state.relations };
    for (const [id, summary] of Object.entries(relations)) {
      if (this.deleted.has(id) || (this.summaryReads.get(id) ?? 0) > read) continue;
      this.summaryReads.set(id, read); next[id] = summary;
    }
    return next;
  }
  invalidateRelations = () => this.replace({ ...this.state, relationVersion: this.state.relationVersion + 1, relations: {} });
  query = async (query: TaskQuery) => {
    const version = this.state.relationVersion;
    const read = ++this.relationRead;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && !(key === 'excludeIds' && Array.isArray(value) && !value.length)) params.set(key, Array.isArray(value) ? value.join(',') : String(value));
    const result = await fetchJson<TaskList>(`/api/tasks?${params}`, undefined, TaskListSchema);
    this.cache(result.tasks, result.relations, version, read);
    return result;
  };
  relations = async (id: string, ancestorOffset = 0) => {
    const version = this.state.relationVersion;
    const read = ++this.relationRead;
    const result = await fetchJson<TaskRelations>(`/api/tasks/${encodeURIComponent(id)}/relations?ancestorOffset=${ancestorOffset}`, undefined, TaskRelationsSchema);
    if (!this.deleted.has(id)) this.cache([result.task, ...result.ancestors, ...result.dependencies], { [id]: result.summary }, version, read);
    return result;
  };
  apply = (task: Task, changedEvent = false) => {
    if (this.deleted.has(task.taskId)) return;
    const before = this.state.tasks.find((item) => item.taskId === task.taskId);
    if (before && before.revision > task.revision) return;
    if (task.deletedAt) {
      const wasLoading = this.state.loading;
      const listed = this.state.panelIds.includes(task.taskId);
      this.deleted.add(task.taskId);
      ++this.read;
      this.replace({
        ...this.state, relationVersion: this.state.relationVersion + 1, relations: {}, tasks: this.state.tasks.filter((item) => item.taskId !== task.taskId),
        panelIds: this.state.panelIds.filter((id) => id !== task.taskId),
        total: Math.max(0, this.state.total - (this.matches(task) ? 1 : 0)), loading: false,
        selected: this.state.selected === task.taskId ? null : this.state.selected,
        nextOffset: this.state.nextOffset === null ? null : Math.max(0, this.state.nextOffset - (listed ? 1 : 0)),
      });
      if (wasLoading) void this.refresh();
      return;
    }
    const changed = changedEvent || !before || before.revision < task.revision;
    // 预读已合并同版本对象时，事件中无法再取得旧父身份，保守重读聚合事实。
    const relations = changedEvent && (!before || before.revision === task.revision) ? {} : { ...this.state.relations };
    if (changed) {
      for (const id of [task.taskId, before?.parentTaskId, task.parentTaskId]) if (id) delete relations[id];
      for (const item of this.state.tasks) if (item.parentTaskId === task.taskId || item.dependencyIds.includes(task.taskId)) delete relations[item.taskId];
    }
    const listed = this.state.panelIds.includes(task.taskId);
    const include = listed || this.matches(task);
    this.replace({ ...this.state, relationVersion: this.state.relationVersion + (changed ? 1 : 0), relations,
      tasks: [...this.state.tasks.filter((item) => item.taskId !== task.taskId), task].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      panelIds: include && !listed ? [...this.state.panelIds, task.taskId] : this.state.panelIds,
      total: this.state.total + (!before && include ? 1 : 0),
    });
  };
  refresh = async (more = false, resetCache = false) => {
    const read = ++this.read;
    const relationVersion = this.state.relationVersion;
    const relationRead = ++this.relationRead;
    const relations: Record<string, TaskRelationSummary> = {};
    let offset = more ? this.state.nextOffset : 0;
    if (offset === null) return;
    this.replace({ ...this.state, loading: true, error: '' });
    try {
      const received: Task[] = [];
      let result: TaskList;
      let pages = more ? 1 : Math.ceil(this.windowSize / 100);
      do {
        const params = new URLSearchParams({ includeRelations: 'true', limit: '100', sort: 'recent', offset: String(offset), ...this.filter });
        result = await fetchJson<TaskList>(`/api/tasks?${params}`, undefined, TaskListSchema);
        if (read !== this.read) return;
        received.push(...result.tasks);
        Object.assign(relations, result.relations);
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
      const cache = new Map(latest);
      if (resetCache) {
        // 重连重新核对共享的关系对象；分页未出现不能作为删除证明。
        const extras = [...latest.keys()].filter((id) => !tasks.some((task) => task.taskId === id));
        for (let offset = 0; offset < extras.length; offset += 100) {
          const ids = extras.slice(offset, offset + 100);
          const page = await this.query({ ids, limit: 100, includeRelations: true });
          if (read !== this.read) return;
          if (relationVersion !== this.state.relationVersion) { this.replace({ ...this.state, loading: false }); this.reconcile(); return; }
          const found = new Set(page.tasks.map((task) => task.taskId));
          for (const id of ids) {
            if (!found.has(id)) { this.deleted.add(id); cache.delete(id); }
            else { const task = this.state.tasks.find((task) => task.taskId === id); if (task) cache.set(id, task); }
          }
        }
      }
      for (const task of tasks) {
        const current = latest.get(task.taskId);
        cache.set(task.taskId, current && current.revision > task.revision ? current : task);
      }
      for (const task of this.state.tasks) {
        const previous = cache.get(task.taskId);
        if (!previous || task.revision > previous.revision) cache.set(task.taskId, task);
      }
      for (const id of this.deleted) { cache.delete(id); ids.delete(id); }
      for (const task of received) if ((cache.get(task.taskId)?.revision ?? 0) > task.revision) delete relations[task.taskId];
      this.loaded = true;
      if (more) this.windowSize = Math.max(this.windowSize, (this.state.nextOffset ?? 0) + 100);
      this.replace({ ...this.state, relations: this.mergeRelations(relations, relationVersion, relationRead), tasks: [...cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId)), panelIds: [...ids], total: result.total, nextOffset: result.nextOffset, loading: false,
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
  update = async (task: Task, patch: UpdateTask['patch'], commandId: string = crypto.randomUUID()) => {
    const result = await fetchJson<{ task: Task; commandId: string }>(`/api/tasks/${encodeURIComponent(task.taskId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, revision: task.revision, patch }) }, TaskReceiptSchema); this.apply(result.task); return result.task;
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
    if (event.type === 'task.changed') { store.apply(event.task, true); store.reconcile(); }
    if (event.type === 'request.changed') store.reconcile();
    if (event.type === 'workbench.connected') { store.invalidateRelations(); void store.refresh(false, true); }
  });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTasks() {
  const store = useContext(Context);
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), store?.snapshot ?? (() => EMPTY));
  return { ...state, store };
}
