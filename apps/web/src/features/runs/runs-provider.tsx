import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { RunsStore } from './runs-store.js';
import { ProcessesStore } from './processes-store.js';
import { scheduleStatusRefresh } from './status-refresh.js';

const Context = createContext<RunsStore | null>(null);
const ProcessesContext = createContext<ProcessesStore | null>(null);
export function RunsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new RunsStore());
  const [processes] = useState(() => new ProcessesStore());
  const refresh = useRef<{ runs: ReturnType<typeof scheduleStatusRefresh>; processes: ReturnType<typeof scheduleStatusRefresh> } | null>(null);
  useEffect(() => {
    const runs = scheduleStatusRefresh(store);
    const processReads = scheduleStatusRefresh(processes);
    refresh.current = { runs, processes: processReads };
    runs.queue();
    processReads.queue();
    // 工作台变更不回放；前台恢复与低频核对补齐漏通知。
    const refreshForeground = () => {
      if (document.visibilityState === 'hidden') return;
      runs.foreground();
      processReads.foreground();
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      runs.poll();
      processReads.poll();
    }, 5000);
    document.addEventListener('visibilitychange', refreshForeground);
    window.addEventListener('focus', refreshForeground);
    window.addEventListener('online', refreshForeground);
    return () => {
      refresh.current = null;
      runs.dispose();
      processReads.dispose();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshForeground);
      window.removeEventListener('focus', refreshForeground);
      window.removeEventListener('online', refreshForeground);
    };
  }, [store, processes]);
  useWorkbenchEvents((event) => {
    if (['workbench.connected', 'task.changed', 'request.changed', 'session.changed', 'process.changed', 'subagent.changed'].includes(event.type)) refresh.current?.runs.queue();
    if (['workbench.connected', 'task.changed', 'process.changed'].includes(event.type)) refresh.current?.processes.queue();
  });
  return <Context.Provider value={store}><ProcessesContext.Provider value={processes}>{children}</ProcessesContext.Provider></Context.Provider>;
}
export function useProcesses() {
  const store = useContext(ProcessesContext);
  if (!store) throw new Error('进程查询必须在 RunsProvider 内使用。');
  return { store, ...useSyncExternalStore(store.subscribe, store.snapshot) };
}
export function useRuns() {
  const store = useContext(Context);
  if (!store) throw new Error('运行查询必须在 RunsProvider 内使用。');
  return { store, ...useSyncExternalStore(store.subscribe, store.snapshot) };
}
