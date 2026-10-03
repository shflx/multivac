import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { useAssistantSession } from './assistant-session.js';
import { SessionReadState } from './session-read-state.js';
import { sessionStatus } from './session-status.js';

const reads = new SessionReadState(() => localStorage);
const listeners = new Set<() => void>();
const receive = (event: StorageEvent) => { if (event.storageArea === localStorage) reads.sync(event.key, event.newValue); };
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', receive);
  listeners.add(listener);
  const unsubscribe = reads.subscribe(listener);
  return () => {
    unsubscribe(); listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', receive);
  };
}

export function useSessionReadCursor(sessionId: string): number {
  return useSyncExternalStore(subscribe, () => reads.get(sessionId));
}

/** 只有实际聚焦的可见会话才算查看；侧栏、快速跳转、后台标签页都不会消除未读。 */
export function useMarkSessionViewed(sessionId: string, active: boolean, panel: RefObject<HTMLElement | null>): void {
  const entry = useAssistantSession(sessionId);
  const status = sessionStatus(entry?.session);
  const endedCursor = status?.endedCursor;
  useEffect(() => {
    if (!active || endedCursor == null) return;
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus() && panel.current?.contains(document.activeElement)) {
        reads.mark(sessionId, endedCursor);
      }
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    document.addEventListener('focusin', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
      document.removeEventListener('focusin', mark);
    };
  }, [active, endedCursor, panel, sessionId]);
}
