import { RunsSnapshotSchema, type RunsSnapshot } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';

interface State { data: RunsSnapshot | null; loading: boolean; error: string; offset: number }
/** 全局只读缓存；事件和重连使在途读取失效，不重放控制命令。 */
export class RunsStore {
  private state: State = { data: null, loading: false, error: '', offset: 0 };
  private generation = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly fetch: (offset: number) => Promise<RunsSnapshot> = (offset) => fetchJson(`/api/runs?offset=${offset}&limit=100`, undefined, RunsSnapshotSchema)) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(state: State) { this.state = state; for (const listener of this.listeners) listener(); }
  refresh = async (offset = this.state.offset) => {
    const generation = ++this.generation;
    this.set({ ...this.state, loading: true, error: '', offset });
    try {
      const data = await this.fetch(offset);
      if (generation !== this.generation) return;
      if (this.state.data && data.version < this.state.data.version) { this.set({ ...this.state, loading: false }); return; }
      this.set({ data, loading: false, error: '', offset });
    } catch (error) {
      if (generation === this.generation) this.set({ ...this.state, loading: false, error: error instanceof Error ? error.message : '运行状态读取失败。' });
    }
  };
}
