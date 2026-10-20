import { ProcessListSchema, type ProcessList } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { readStatus } from './status-query.js';

export interface ProcessesState {
  data: ProcessList | null;
  /** 弹层固定使用首页的列表及同次响应的总数，不随运行页翻页。 */
  overview: ProcessList | null;
  loading: boolean;
  error: string;
  offset: number;
}

export class ProcessesStore {
  private state: ProcessesState = { data: null, overview: null, loading: false, error: '', offset: 0 };
  private generation = 0;
  private controller: AbortController | undefined;
  private listeners = new Set<() => void>();
  constructor(private readonly fetch: (offset: number, signal: AbortSignal) => Promise<ProcessList> = (offset, signal) => fetchJson(`/api/processes?activeOnly=true&offset=${offset}`, { signal }, ProcessListSchema)) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private emit() { for (const listener of this.listeners) listener(); }
  refresh = async (offset = this.state.offset) => {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    this.state = { ...this.state, loading: true, offset }; this.emit();
    try {
      const [data, overview] = await readStatus(async signal => {
        // 运行页可翻页；弹层计数和前五条明细始终来自同一首页快照。
        const first = this.fetch(0, signal);
        return offset === 0 ? first.then(value => [value, value] as const) : Promise.all([this.fetch(offset, signal), first]);
      }, '进程状态读取超时，请重试。', controller.signal);
      if (generation !== this.generation) return;
      if (offset > 0 && offset >= data.total) { await this.refresh(Math.max(0, Math.floor((data.total - 1) / 100) * 100)); return; }
      const previous = new Map(this.state.overview?.processes.map(item => [item.processId, item]) ?? []);
      for (const item of this.state.data?.processes ?? []) {
        if ((previous.get(item.processId)?.revision ?? 0) < item.revision) previous.set(item.processId, item);
      }
      const merge = (list: ProcessList): ProcessList => {
        list.processes = list.processes.map(item => (previous.get(item.processId)?.revision ?? 0) > item.revision ? previous.get(item.processId)! : item);
        return list;
      };
      const confirmed = merge(overview);
      this.state = { data: offset === 0 ? confirmed : merge(data), overview: confirmed, loading: false, error: '', offset }; this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : '进程读取失败。' }; this.emit();
    }
  };
}
