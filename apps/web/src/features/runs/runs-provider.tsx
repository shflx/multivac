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
