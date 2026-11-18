const MIN_REFRESH_INTERVAL_MS = 250;

interface StatusStore {
  snapshot(): { loading: boolean };
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
}

/** 普通变更只登记待补读；显式刷新不受此调度器限制。 */
export function scheduleStatusRefresh(store: StatusStore) {
  let pending = false;
  let lastStart = -Infinity;
  let lastForeground = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function start() {
    pending = false;
    clearTimeout(timer);
    timer = undefined;
    lastStart = Date.now();
    void store.refresh();
  }

  function flush() {
    if (!pending || store.snapshot().loading || timer !== undefined) return;
    const wait = MIN_REFRESH_INTERVAL_MS - (Date.now() - lastStart);
    if (wait <= 0) start();
    else timer = setTimeout(() => { timer = undefined; flush(); }, wait);
  }

  const unsubscribe = store.subscribe(flush);
  return {
    queue() { pending = true; flush(); },
    poll() { if (!store.snapshot().loading) { pending = true; flush(); } },
    foreground() {
      const now = Date.now();
      // 一次恢复可替换旧查询；紧邻的 focus、visibilitychange、online 不再重发。
      if (now - lastForeground < MIN_REFRESH_INTERVAL_MS) return;
      lastForeground = now;
      start();
    },
    dispose() { unsubscribe(); clearTimeout(timer); },
  };
}
