import type { CompactSessionContext, ContextCompactionOperation, SessionContextResponse } from '@multivac/contracts';

export interface ContextViewState {
  data: SessionContextResponse | null;
  operation: ContextCompactionOperation | null;
  error: string | null;
  reading: boolean;
  pending: boolean;
  stale: boolean;
}
export function contextOperationPending(op: ContextCompactionOperation): boolean {
  return op.status === 'running' || op.status === 'reconciliation-required' || op.commitState === 'unknown';
}

/** 每会话一份；事件使在途读取失效，刷新只核对原操作，任何读取都不重发 POST。 */
export class SessionContextController {
  private state: ContextViewState = { data: null, operation: null, error: null, reading: false, pending: false, stale: true };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = false;
  private queued = false;
  private flight: Promise<void> | null = null;
  private posting = false;
  private pendingId: string | null = null;
  constructor(readonly sessionId: string, private readonly api: {
    read(sessionId: string): Promise<SessionContextResponse>;
    operation(sessionId: string, id: string): Promise<ContextCompactionOperation | null>;
    compact(command: CompactSessionContext): Promise<ContextCompactionOperation>;
    newId(): string;
    loadPending(): string | null;
    savePending(id: string | null): void;
  }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getState = () => this.state;
  private update(patch: Partial<ContextViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
  start(): void {
    this.active = true;
    try { this.pendingId = this.api.loadPending(); }
    catch { this.update({ error: '无法读取本地操作记录，先核对服务端状态。' }); }
    if (this.pendingId) this.update({ pending: true });
    void this.refresh();
  }
  stop(): void { this.active = false; this.epoch++; this.queued = false; }
  invalidate = (): void => {
    this.epoch++;
    this.update({ stale: true });
    void this.refresh();
  };
  refresh = (): Promise<void> => {
    if (!this.active) return Promise.resolve();
    if (this.flight) { this.queued = true; return this.flight; }
    const epoch = this.epoch;
    this.update({ reading: true });
    this.flight = (async () => {
      try {
        const own = this.pendingId ? await this.api.operation(this.sessionId, this.pendingId) : null;
        const data = await this.api.read(this.sessionId);
        if (!this.active || epoch !== this.epoch) return;
        if (data.state.sessionId !== this.sessionId) throw new Error('上下文状态的会话身份不一致。');
        const operation = data.operation && contextOperationPending(data.operation) ? data.operation : own ?? data.operation;
        let unresolved = Boolean(this.pendingId && !own);
        if (own && !contextOperationPending(own)) {
          try { this.api.savePending(null); this.pendingId = null; }
          catch { unresolved = true; }
        }
        this.update({ data, operation, stale: false, pending: this.posting || unresolved || Boolean(operation && contextOperationPending(operation)),
          error: unresolved ? '原操作结果尚不可核对，不会自动重发；请稍后刷新状态。' : null });
      } catch (error) {
        if (this.active && epoch === this.epoch) this.update({ stale: true, error: error instanceof Error ? error.message : '上下文状态暂不可读取。' });
      }
    })().finally(() => {
      this.flight = null;
      if (this.active) {
        this.update({ reading: false });
        if (this.queued) { this.queued = false; void this.refresh(); }
      }
    });
    return this.flight;
  };
  compact = async (): Promise<void> => {
    const data = this.state.data;
    if (!this.active || this.posting || this.state.pending || this.state.stale || this.state.reading || !data?.state.compaction.available) return;
    const operationId = this.api.newId();
    try { this.api.savePending(operationId); }
    catch { this.update({ error: '无法保存操作身份，压缩尚未发起。' }); return; }
    this.pendingId = operationId;
    this.posting = true;
    this.epoch++;
    this.update({ pending: true, stale: true, error: null });
    try {
      await this.api.compact({ operationId, sessionId: this.sessionId, revision: data.state.revision });
    } catch {
      if (this.active) this.update({ error: '压缩响应未知，正在核对原操作；不会自动重发。' });
    } finally {
      this.posting = false;
      if (this.active) void this.refresh();
    }
  };
}
