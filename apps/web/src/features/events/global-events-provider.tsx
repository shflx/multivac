import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { GlobalEventStream } from './global-event-stream.js';

const GlobalEventsContext = createContext<GlobalEventStream | null>(null);

/**
 * 本窗口唯一的全局事件流：会话状态（`AssistantSessionsProvider`）与工作台同步（`WorkbenchSyncProvider`）
 * 都从这一条连接取事件，不再各自建立连接。
 */
export function GlobalEventsProvider({ children }: { children: ReactNode }) {
  const [stream] = useState(() => new GlobalEventStream());

  useEffect(() => {
    stream.open();
    return () => stream.close();
  }, [stream]);

  return <GlobalEventsContext.Provider value={stream}>{children}</GlobalEventsContext.Provider>;
}

export function useGlobalEvents(): GlobalEventStream {
  const stream = useContext(GlobalEventsContext);
  if (!stream) throw new Error('全局事件流必须在 GlobalEventsProvider 内使用。');
  return stream;
}
