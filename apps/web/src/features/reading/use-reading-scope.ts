import { useEffect, useRef, useState } from 'react';
import type { BookPosition, ReadingScope, ReadingScopeCommand } from '@multivac/contracts';
import { getReadingScope, setReadingScope } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

/** 正文与书伴共用同一已读事实，浏览、定位和面板切换不会推进边界。 */
export function useReadingScope(bookId: string) {
  const [scope, setScope] = useState<ReadingScope | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ReadingScopeCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  async function refresh() {
    try { const next = await getReadingScope(bookId); setScope(current => !current || next.revision >= current.revision ? next : current); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); }, [bookId]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === bookId) void refresh(); });
  async function execute(command: ReadingScopeCommand) {
    if (sending.current) return false;
    sending.current = true; setBusy(true); setError(''); setPending(command);
    try {
      const result = await setReadingScope(bookId, command), latest = await getReadingScope(bookId);
      setScope(current => [current, result, latest].filter((s): s is ReadingScope => Boolean(s)).reduce((a, b) => a.revision > b.revision ? a : b));
      setPending(null);
      if (latest.revision > result.revision) setError('范围随后在别处更新，已显示最新事实。');
      return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { sending.current = false; setBusy(false); }
  }
  return { scope, error, pending, busy, refresh,
    mark: (boundary: BookPosition | null) => scope && !pending ? execute({ commandId: crypto.randomUUID(), expectedRevision: scope.revision, boundary }) : Promise.resolve(false),
    retry: () => pending ? execute(pending) : Promise.resolve(false),
    reconcile: () => { setPending(null); setError(''); void refresh(); },
  };
}
