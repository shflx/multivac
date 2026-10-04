import { ProcessListSchema, type ProcessList } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';

export class ProcessesStore {
  private state: { data: ProcessList | null; loading: boolean; error: string; offset: number } = { data: null, loading: false, error: '', offset: 0 };
  private generation = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private emit() { for (const listener of this.listeners) listener(); }
  refresh = async (offset = this.state.offset) => {
    const generation = ++this.generation;
    this.state = { ...this.state, loading: true, error: '', offset }; this.emit();
    try {
      const data = await fetchJson<ProcessList>(`/api/processes?offset=${offset}`, undefined, ProcessListSchema);
      if (generation !== this.generation) return;
      const previous = new Map(this.state.data?.processes.map((item) => [item.processId, item]) ?? []);
      data.processes = data.processes.map((item) => (previous.get(item.processId)?.revision ?? 0) > item.revision ? previous.get(item.processId)! : item);
      this.state = { data, loading: false, error: '', offset }; this.emit();
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : '进程读取失败。' }; this.emit();
    }
  };
}
