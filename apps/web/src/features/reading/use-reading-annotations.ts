import { useEffect, useRef, useState } from 'react';
import type { AnnotationCommand, ReadingAnnotation } from '@multivac/contracts';
import { annotateBook, listAnnotations } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function useReadingAnnotations(bookId: string) {
  const [records, setRecords] = useState<ReadingAnnotation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AnnotationCommand | null>(null);
  const generation = useRef(0);
  const sending = useRef(false);
  async function refresh() {
    const token = ++generation.current;
    try { const result = await listAnnotations(bookId); if (token === generation.current) setRecords(result.records); }
    catch (e) { if (token === generation.current) setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [bookId]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === bookId) void refresh(); });
  async function execute(command: AnnotationCommand) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(''); setPending(command);
    try {
      await annotateBook(bookId, command); setPending(null); await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { sending.current = false; setBusy(false); }
  }
  return { records, error, busy, pending, refresh, execute, dismiss: () => { setPending(null); setError(''); void refresh(); } };
}
