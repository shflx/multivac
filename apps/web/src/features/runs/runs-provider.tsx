import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { RunsStore } from './runs-store.js';

const Context = createContext<RunsStore | null>(null);
export function RunsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new RunsStore());
  useEffect(() => { void store.refresh(); }, [store]);
  useWorkbenchEvents((event) => {
    if (['workbench.connected', 'task.changed', 'request.changed', 'session.changed'].includes(event.type)) void store.refresh();
  });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useRuns() {
  const store = useContext(Context);
  if (!store) throw new Error('运行查询必须在 RunsProvider 内使用。');
  return { store, ...useSyncExternalStore(store.subscribe, store.snapshot) };
}
