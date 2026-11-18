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
  let foregroundSnapshot: ReturnType<StatusStore['snapshot']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let foregroundTimer: ReturnType<typeof setTimeout> | undefined;

  function start() {
    pending = false;
    clearTimeout(timer);
    timer = undefined;
    lastStart = Date.now();
    void store.refresh();
  }

  function flush() {
    if (!pending || store.snapshot().loading || timer !== undefined || foregroundTimer !== undefined) return;
    const wait = MIN_REFRESH_INTERVAL_MS - (Date.now() - lastStart);
    if (wait <= 0) start();
    else timer = setTimeout(() => { timer = undefined; flush(); }, wait);
  }

  function startForeground() {
    clearTimeout(foregroundTimer);
    foregroundTimer = undefined;
    lastForeground = Date.now();
    start();
    foregroundSnapshot = store.snapshot();
  }

  const unsubscribe = store.subscribe(flush);
  return {
    queue() { pending = true; flush(); },
    poll() { if (!store.snapshot().loading) { pending = true; flush(); } },
    foreground() {
      const wait = MIN_REFRESH_INTERVAL_MS - (Date.now() - lastForeground);
      if (wait <= 0) startForeground();
      // 同轮恢复信号合并；若状态已落定或被手动刷新替换，不丢掉新的恢复机会。
      else if (store.snapshot() !== foregroundSnapshot && foregroundTimer === undefined) {
        foregroundTimer = setTimeout(startForeground, wait);
      }
    },
    dispose() { unsubscribe(); clearTimeout(timer); clearTimeout(foregroundTimer); },
  };
}
