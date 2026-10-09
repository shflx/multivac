import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { RunsStore } from './runs-store.js';
import { ProcessesStore } from './processes-store.js';

const Context = createContext<RunsStore | null>(null);
const ProcessesContext = createContext<ProcessesStore | null>(null);
export function RunsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new RunsStore());
  const [processes] = useState(() => new ProcessesStore());
  useEffect(() => { void store.refresh(); }, [store]);
  useEffect(() => { void processes.refresh(); }, [processes]);
  useEffect(() => {
    // 工作台变更不回放；前台恢复与低频核对补齐漏通知，避免顶栏一直保留空快照。
    const refreshVisible = () => {
      if (document.visibilityState === 'hidden') return;
      if (!store.snapshot().loading) void store.refresh();
      if (!processes.snapshot().loading) void processes.refresh();
    };
    const timer = setInterval(refreshVisible, 5000);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('focus', refreshVisible);
    window.addEventListener('online', refreshVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [store, processes]);
  useWorkbenchEvents((event) => {
    if (['workbench.connected', 'task.changed', 'request.changed', 'session.changed', 'process.changed'].includes(event.type)) void store.refresh();
    if (['workbench.connected', 'task.changed', 'process.changed'].includes(event.type)) void processes.refresh();
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
