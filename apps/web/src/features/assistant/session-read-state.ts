const PREFIX = 'multivac.session-read.v1:';
type ReadStorage = Pick<Storage, 'getItem' | 'setItem'>;
const cursorOf = (value: string | null): number => {
  const cursor = Number(value);
  return Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
};

/** 阅读水位按会话保存在本机；同窗口立即同步，其他窗口通过 storage 事件同步。 */
export class SessionReadState {
  private readonly cursors = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: () => ReadStorage) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private stored(sessionId: string): number {
    try { return cursorOf(this.storage().getItem(PREFIX + sessionId)); }
    catch { return 0; }
  }
  get = (sessionId: string): number => {
    if (!this.cursors.has(sessionId)) this.cursors.set(sessionId, this.stored(sessionId));
    return this.cursors.get(sessionId)!;
  };
  mark = (sessionId: string, cursor: number): void => {
    if (!Number.isFinite(cursor) || cursor <= 0) return;
    const next = Math.max(cursor, this.get(sessionId), this.stored(sessionId));
    if (next === this.get(sessionId)) return;
    this.cursors.set(sessionId, next);
    try { this.storage().setItem(PREFIX + sessionId, String(next)); }
    catch { /* 本机存储不可用时，当前窗口仍保留已查看状态。 */ }
    this.emit();
  };
  sync = (key: string | null, value: string | null): void => {
    if (key === null) { this.cursors.clear(); this.emit(); return; }
    if (!key.startsWith(PREFIX)) return;
    const id = key.slice(PREFIX.length);
    const next = Math.max(this.cursors.get(id) ?? 0, cursorOf(value));
    if (next === this.cursors.get(id)) return;
    this.cursors.set(id, next);
    this.emit();
  };
  private emit() { for (const listener of this.listeners) listener(); }
}
