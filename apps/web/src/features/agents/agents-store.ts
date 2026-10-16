import type { AgentList, WorkbenchEvent } from '@multivac/contracts';
import { listAgents } from '../../data/agent-api.js';

interface State { data: AgentList | null; loading: boolean; error: string }

/** 窗口内共享列表与在途请求；变更发生在查询期间时，丢弃旧响应并补读一次。 */
export class AgentsStore {
  private state: State = { data: null, loading: false, error: '' };
  private inFlight: Promise<void> | null = null;
  private reloadAfter = false;
  private lastEvent: WorkbenchEvent | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly read: () => Promise<AgentList> = listAgents) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(state: State) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** 挂载或打开菜单时合并在途读取；已缓存的数据可在刷新期间继续显示。 */
  load = () => this.request(false);
  /** 修改后必须读到新事实，不能复用修改前已经发出的请求。 */
  refresh = () => this.request(true);

  applyEvent = (event: WorkbenchEvent) => {
    if (event.type !== 'agent.changed' && event.type !== 'workbench.connected') return;
    // 同一工作台事件会转给多个组件，只让第一个订阅者触发刷新。
    if (event === this.lastEvent) return;
    this.lastEvent = event;
    void this.refresh();
  };

  private request(invalidate: boolean): Promise<void> {
    if (this.inFlight) {
      this.reloadAfter ||= invalidate;
      return this.inFlight;
    }
    this.set({ ...this.state, loading: true, error: '' });
    this.inFlight = Promise.resolve().then(() => this.read()).then(data => {
      if (!this.reloadAfter) this.set({ data, loading: false, error: '' });
    }).catch(error => {
      if (!this.reloadAfter) this.set({ ...this.state, loading: false, error: error instanceof Error ? error.message : '智能体列表读取失败。' });
    }).finally(async () => {
      this.inFlight = null;
      if (this.reloadAfter) {
        this.reloadAfter = false;
        await this.load();
      }
    });
    return this.inFlight;
  }
}
