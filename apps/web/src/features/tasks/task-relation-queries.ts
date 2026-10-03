import type { TaskQuery, TaskRelations } from '@multivac/contracts';
import type { TasksStore } from './tasks-provider.js';

interface QueryState { ids: readonly string[]; total: number; nextOffset: number | null; loading: boolean; error: string }
const EMPTY: QueryState = { ids: [], total: 0, nextOffset: null, loading: false, error: '' };

/** 独立查询只保留成员与分页；任务对象始终从共享缓存取得。 */
export class TaskRelationQuery {
  private state = EMPTY;
  private read = 0;
  private size = 50;
  private listeners = new Set<() => void>();
  constructor(private readonly store: TasksStore, readonly query: TaskQuery) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private replace(state: QueryState) { this.state = state; for (const listener of this.listeners) listener(); }
  dispose = () => { ++this.read; };
  refresh = async (more = false) => {
    if (more && (this.state.loading || this.state.nextOffset === null)) return;
    const read = ++this.read;
    const version = this.store.snapshot().relationVersion;
    let offset = more ? this.state.nextOffset! : 0;
    let pages = more ? 1 : Math.ceil(this.size / 50);
    const ids = new Set(more ? this.state.ids : []);
    this.replace({ ...this.state, loading: true, error: '' });
    try {
      let total = 0;
      let nextOffset: number | null = null;
      do {
        const page = await this.store.query({ ...this.query, includeRelations: true, limit: 50, offset });
        if (read !== this.read) return;
        if (version !== this.store.snapshot().relationVersion) { void this.refresh(); return; }
        for (const task of page.tasks) ids.add(task.taskId);
        total = page.total; nextOffset = page.nextOffset;
        if (nextOffset === null) break;
        offset = nextOffset;
      } while (--pages > 0);
      if (more) this.size += 50;
      this.replace({ ids: [...ids], total, nextOffset, loading: false, error: '' });
    } catch (failure) {
      if (read === this.read) this.replace({ ...this.state, loading: false, error: failure instanceof Error ? failure.message : '关系任务未读取。' });
    }
  };
}

type RelationFacts = Pick<TaskRelations, 'summary' | 'nextAncestorOffset' | 'missingDependencyIds' | 'editReason' | 'parentChangeReason'> & { revision: number; version: number };
interface ContextState { value: RelationFacts | null; ancestorIds: readonly string[]; loading: boolean; error: string }
export class TaskRelationContext {
  private state: ContextState = { value: null, ancestorIds: [], loading: false, error: '' };
  private read = 0;
  private size = 100;
  private listeners = new Set<() => void>();
  constructor(private readonly store: TasksStore, private readonly taskId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private replace(state: ContextState) { this.state = state; for (const listener of this.listeners) listener(); }
  dispose = () => { ++this.read; };
  refresh = async (more = false) => {
    if (more && (this.state.loading || this.state.value?.nextAncestorOffset == null)) return;
    const read = ++this.read;
    const version = this.store.snapshot().relationVersion;
    const ancestors = new Set(more ? this.state.ancestorIds : []);
    let offset = more ? this.state.value!.nextAncestorOffset! : 0;
    let pages = more ? 1 : Math.ceil(this.size / 100);
    this.replace({ ...this.state, loading: true, error: '' });
    try {
      let value: TaskRelations;
      do {
        value = await this.store.relations(this.taskId, offset);
        if (read !== this.read) return;
        if (version !== this.store.snapshot().relationVersion) { void this.refresh(); return; }
        for (const task of value.ancestors) ancestors.add(task.taskId);
        if (value.nextAncestorOffset === null) break;
        offset = value.nextAncestorOffset;
      } while (--pages > 0);
      if (more) this.size += 100;
      this.replace({ value: { summary: value.summary, nextAncestorOffset: value.nextAncestorOffset, missingDependencyIds: value.missingDependencyIds, editReason: value.editReason, parentChangeReason: value.parentChangeReason, revision: value.task.revision, version }, ancestorIds: [...ancestors], loading: false, error: '' });
    } catch (failure) {
      if (read === this.read) this.replace({ ...this.state, loading: false, error: failure instanceof Error ? failure.message : '任务关系未读取。' });
    }
  };
}
