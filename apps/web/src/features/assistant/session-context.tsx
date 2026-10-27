import { useEffect, useState, useSyncExternalStore } from 'react';
import { readSessionContext, readContextOperation, compactSessionContext } from '../../data/session-context-api.js';
import { newCommandId } from '../../data/command-id.js';
import { useOptionalWorkbenchEvents } from '../workbench/workbench-sync-provider.js';
import { SessionContextController } from './context-controller.js';

/** 由会话宿主创建；首页、侧栏和工作面板共享控制器。 */
export function useSessionContextController(sessionId: string, active: boolean) {
  const [controller] = useState(() => new SessionContextController(sessionId, {
    read: readSessionContext, operation: readContextOperation, compact: compactSessionContext, newId: newCommandId,
    loadPending: () => window.localStorage.getItem(`multivac.context-operation.${sessionId}`),
    savePending: id => {
      const key = `multivac.context-operation.${sessionId}`;
      if (id) window.localStorage.setItem(key, id); else window.localStorage.removeItem(key);
    },
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useOptionalWorkbenchEvents(event => {
    if (active && (event.type === 'workbench.connected' || event.type === 'session-context.changed' && event.sessionId === sessionId || event.type === 'model-selection.changed' &&
      (event.sessionId === null || event.sessionId === sessionId))) controller.invalidate();
  });
  useEffect(() => {
    if (!active) return;
    controller.start();
    const refresh = () => { if (document.visibilityState === 'visible') controller.invalidate(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.stop();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [controller, active]);
  return { ...state, refresh: controller.refresh, invalidate: controller.invalidate, compact: controller.compact };
}
export type SessionContext = ReturnType<typeof useSessionContextController>;
