import { useEffect, useRef, useState } from 'react';
import type { AnnotationCommand, ReadingAnnotation } from '@multivac/contracts';
import { AssistantApiError } from '../../data/assistant-api.js';
import { annotateBook, listAnnotations } from '../../data/reading-api.js';
import { useWorkbenchEvents } from '../workbench/workbench-sync-provider.js';

export function useReadingAnnotations(bookId: string) {
  const [records, setRecords] = useState<ReadingAnnotation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AnnotationCommand | null>(null);
  const [removedHighlight, setRemovedHighlight] = useState<ReadingAnnotation | null>(null);
  const removal = useRef<{ commandId: string; record: ReadingAnnotation } | null>(null);
  const restoreCommandId = useRef<string | null>(null);
  const pendingRef = useRef<AnnotationCommand | null>(null);
  const recordsRef = useRef(records); recordsRef.current = records;
  const generation = useRef(0);
  const sending = useRef(false);
  function setPendingCommand(command: AnnotationCommand | null) { pendingRef.current = command; setPending(command); }
  async function refresh() {
    const token = ++generation.current;
    try { const result = await listAnnotations(bookId); if (token === generation.current) setRecords(result.records); }
    catch (e) { if (token === generation.current) setError((e as Error).message); }
  }
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [bookId]);
  useWorkbenchEvents(event => { if (event.type === 'workbench.connected' || event.type === 'reading.changed' && event.bookId === bookId) void refresh(); });
  async function execute(command: AnnotationCommand) {
    if (sending.current || pendingRef.current && pendingRef.current.commandId !== command.commandId) return false;
    if (command.action === 'delete' && command.kind === 'highlight' && removal.current?.commandId !== command.commandId) {
      const record = recordsRef.current.find(record => record.id === command.id);
      if (record) removal.current = { commandId: command.commandId, record: structuredClone(record) };
    }
    sending.current = true; setBusy(true); setError(''); setPendingCommand(command);
    try {
      await annotateBook(bookId, command); setPendingCommand(null);
      // 回执丢失后仍保留删除前的快照，原命令重试核实成功后才提供撤销。
      if (removal.current?.commandId === command.commandId) { setRemovedHighlight(removal.current.record); removal.current = null; }
      if (restoreCommandId.current === command.commandId) { setRemovedHighlight(null); restoreCommandId.current = null; }
      await refresh();
      return true;
    } catch (e) {
      // 明确拒绝的命令无需原样重试；同步最新版本后允许保留备注重新提交。
      if (e instanceof AssistantApiError && e.code !== 'INTERNAL_ERROR' && [400, 403, 404, 409, 422].includes(e.status)) {
        setPendingCommand(null);
        if (removal.current?.commandId === command.commandId) removal.current = null;
        if (restoreCommandId.current === command.commandId) restoreCommandId.current = null;
        await refresh();
        setError(`${e.message} 请核对最新记录后重新提交，当前备注输入已保留。`);
      } else setError((e as Error).message);
      return false;
    }
    finally { sending.current = false; setBusy(false); }
  }
  function undoRemove() {
    if (!removedHighlight || sending.current || pendingRef.current) return;
    const command: AnnotationCommand = { commandId: crypto.randomUUID(), id: crypto.randomUUID(), expectedRevision: 0, action: 'save', kind: 'highlight', reference: removedHighlight.reference, remark: removedHighlight.remark };
    // 使用新身份恢复，避免删除前的旧版本命令作用于恢复后的标注；未知结果仍重试同一命令。
    restoreCommandId.current = command.commandId;
    void execute(command);
  }
  return { records, error, busy, pending, removedHighlight, undoRemove, dismissUndo: () => setRemovedHighlight(null), refresh, execute,
    dismiss: () => { setPendingCommand(null); setError(''); removal.current = null; restoreCommandId.current = null; void refresh(); } };
}
