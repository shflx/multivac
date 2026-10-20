import { RunsSnapshotSchema, type RunsSnapshot } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { readStatus } from './status-query.js';

export interface RunsState { data: RunsSnapshot | null; loading: boolean; error: string; offset: number }
/** 全局只读缓存；事件和重连使在途读取失效，不重放控制命令。 */
export class RunsStore {
  private state: RunsState = { data: null, loading: false, error: '', offset: 0 };
  private generation = 0;
  private controller: AbortController | undefined;
  private listeners = new Set<() => void>();
  constructor(private readonly fetch: (offset: number, signal: AbortSignal) => Promise<RunsSnapshot> = (offset, signal) => fetchJson(`/api/runs?activeOnly=true&offset=${offset}&limit=100`, { signal }, RunsSnapshotSchema)) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: RunsState) { this.state = state; for (const listener of this.listeners) listener(); }
  refresh = async (offset = this.state.offset) => {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    // 成功补读前保留错误，不能在每次重试时重新把旧空快照显示为当前空闲。
    this.set({ ...this.state, loading: true, offset });
    try {
      const data = await readStatus(signal => this.fetch(offset, signal), '任务运行状态读取超时，请重试。', controller.signal);
      if (generation !== this.generation) return;
      if (this.state.data && data.version < this.state.data.version) { this.set({ ...this.state, loading: false }); return; }
      if (offset > 0 && offset >= data.total) { await this.refresh(Math.max(0, Math.floor((data.total - 1) / 100) * 100)); return; }
      this.set({ data, loading: false, error: '', offset });
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.state, loading: false, error: error instanceof Error ? error.message : '运行状态读取失败。' });
    }
  };
}
