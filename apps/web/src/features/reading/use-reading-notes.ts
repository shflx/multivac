import { useEffect, useRef, useState } from 'react';
import { Check } from 'typebox/value';
import { ReadingNoteDraftSchema, hasUnsavedReadingNote, type ReadingNoteDraft, type ReadingNotesCommand, type ReadingNotesState } from '@multivac/contracts';
import { getReadingNotes, mutateReadingNotes } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function useReadingNotes(bookId: string) {
  const [state, setState] = useState<ReadingNotesState>({ bookId, revision: 0, notes: [], draft: null });
  const [draft, setDraft] = useState<ReadingNoteDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ReadingNotesCommand | null>(null);
  const [target, setTarget] = useState<ReadingNoteDraft | null>(null);
  const stateRef = useRef(state), draftRef = useRef(draft), sending = useRef(false), generation = useRef(0);
  const initialized = useRef(false);
  const conflicted = useRef(false);
  const key = `multivac.reading.note-buffer.${bookId}`;
  function local(next: ReadingNoteDraft | null) {
    draftRef.current = next; setDraft(next);
    try { if (equal(next, stateRef.current.draft)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify({ revision: stateRef.current.revision, draft: next, conflict: conflicted.current })); }
    catch { setError('本机草稿备份失败，请保存后再离开。'); }
  }
  async function refresh() {
    const token = ++generation.current;
    try {
      const next = await getReadingNotes(bookId);
      if (token !== generation.current || sending.current || next.revision < stateRef.current.revision) return;
      if (!initialized.current) {
        initialized.current = true;
        let saved: { revision: number; draft: unknown; conflict?: boolean } | null = null;
        try { saved = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { /* 服务端草稿仍可恢复。 */ }
        if (saved && (saved.draft === null || Check(ReadingNoteDraftSchema, saved.draft)) && !equal(saved.draft, next.draft)) {
          draftRef.current = saved.draft; setDraft(saved.draft);
          conflicted.current = Boolean(saved.conflict) || saved.revision !== next.revision;
          if (conflicted.current) setError('草稿已在其他窗口更新，本机未保存内容仍保留。请核对后继续。');
        } else { draftRef.current = next.draft; setDraft(next.draft); }
      } else if (equal(draftRef.current, stateRef.current.draft)) { draftRef.current = next.draft; setDraft(next.draft); }
      else if (next.revision > stateRef.current.revision && !equal(next.draft, stateRef.current.draft)) { conflicted.current = true; setError('草稿已在其他窗口更新，本机未保存内容仍保留。请核对后继续。'); }
      stateRef.current = next; setState(next); setLoaded(true);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [bookId]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === bookId) void refresh(); });
  async function execute(command: ReadingNotesCommand, replaceLocal = true): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true; setBusy(true); setPending(command); setError(''); ++generation.current;
    try {
      const next = await mutateReadingNotes(bookId, command);
      const readback = await getReadingNotes(bookId);
      const latest = [stateRef.current, next, readback].reduce((a, b) => a.revision > b.revision ? a : b);
      stateRef.current = latest; setState(latest);
      if (latest.revision > next.revision) {
        conflicted.current = true;
        local(draftRef.current); setPending(null);
        setError('原操作已完成，但笔记已在其他窗口继续修改。当前输入已保留，请核对后继续。');
        return false;
      }
      conflicted.current = false;
      local(replaceLocal ? next.draft : draftRef.current);
      setPending(null); return true;
    } catch (e) { setError((e as Error).message); return false; }
    finally { sending.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!loaded || busy || error || pending || equal(draft, state.draft)) return;
    const timer = setTimeout(() => { void execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'draft', draft: draftRef.current }, false); }, 400);
    return () => clearTimeout(timer);
  }, [draft, state, loaded, busy, error, pending]);
  async function flush(): Promise<boolean> {
    if (sending.current || pending || error) return false;
    if (equal(draftRef.current, stateRef.current.draft)) return true;
    return execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'draft', draft: draftRef.current });
  }
  async function request(candidate: ReadingNoteDraft) {
    if (!loaded || sending.current || pending || error) return false;
    if (hasUnsavedReadingNote(stateRef.current, draftRef.current) && !equal(candidate, draftRef.current)) { setTarget(candidate); return true; }
    if (!await flush()) return false;
    return execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'draft', draft: candidate });
  }
  async function save(nextDraft: ReadingNoteDraft | null = null) {
    setLocked(true);
    try {
      if (!await flush()) return false;
      const ok = await execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'save', nextDraft });
      if (ok) setTarget(null); return ok;
    } finally { setLocked(false); }
  }
  async function discard(nextDraft: ReadingNoteDraft | null = null) {
    if (pending || sending.current) return false;
    const ok = await execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'draft', draft: nextDraft, discardExisting: true });
    if (ok) setTarget(null); return ok;
  }
  return { state, draft, target, loaded, busy, locked, error, pending, change: local, request, save, discard, continueDraft: () => setTarget(null),
    deleteNote: async (id: string) => { if (await flush()) await execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'delete', id }); },
    retry: () => pending && void execute(pending), refresh,
    resolveLocal: async () => { setPending(null); setError(''); await refresh(); conflicted.current = false; await execute({ commandId: crypto.randomUUID(), expectedRevision: stateRef.current.revision, action: 'draft', draft: draftRef.current, discardExisting: true }); },
  };
}
