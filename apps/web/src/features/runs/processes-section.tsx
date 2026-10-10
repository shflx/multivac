import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleStop, FileText, LoaderCircle, Server } from 'lucide-react';
import { isActiveManagedProcess, ProcessPreviewSchema, ProcessLogSchema, ProcessStopReceiptSchema, ProcessSessionStopReceiptSchema, type ProcessPreview, type ProcessLog, type ProcessListItem } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useProcesses } from './runs-provider.js';
import { durationLabel } from './run-presentation.js';

const LABELS = { starting: '启动中', running: '运行中', stopping: '停止中', exited: '已退出', failed: '失败', recovery: '恢复核对' };
interface StopConfirmation { processId: string; name: string; preview: ProcessPreview; commandId: string; error: string; sourceTitle?: string; scope?: 'session' }

export function ProcessesSection({ active, onOpenTask, onOpenSession }: { active: boolean; onOpenTask: (id: string) => void; onOpenSession: (id: string) => void }) {
  const { store, data, error, loading, offset } = useProcesses();
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [log, setLog] = useState<ProcessLog | null>(null);
  const [logError, setLogError] = useState('');
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<StopConfirmation | null>(null);
  const section = useRef<HTMLElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const stopTrigger = useRef<HTMLButtonElement | null>(null);
  const lock = useRef(false);
  const [now, setNow] = useState(Date.now);
  const items = data?.processes.filter(isActiveManagedProcess) ?? [];
  const confirmationDetached = !!confirmation && !items.some(item => item.processId === confirmation.processId);

  function restoreFocus(processId: string) {
    requestAnimationFrame(() => {
      const row = [...(section.current?.querySelectorAll<HTMLElement>('[data-process-id]') ?? [])].find(item => item.dataset.processId === processId);
      const target = stopTrigger.current?.isConnected && !stopTrigger.current.disabled ? stopTrigger.current : row?.querySelector<HTMLButtonElement>('.process-log-toggle');
      (target ?? section.current?.querySelector<HTMLButtonElement>('button') ?? section.current)?.focus({ preventScroll: true });
    });
  }
  function cancelStop(processId: string) { setConfirmation(null); restoreFocus(processId); }

  useEffect(() => {
    if (!active) return;
    void store.refresh();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, store]);
  useEffect(() => {
    if (!active || !confirmation) return;
    cancelButton.current?.focus({ preventScroll: true });
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (!lock.current) cancelStop(confirmation!.processId);
    }
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [active, confirmation?.commandId, confirmationDetached, pending]);
  useEffect(() => {
    if (!active || !openLog) return;
    let cancelled = false, cursor = 0, timer: ReturnType<typeof setTimeout>;
    setLog(null); setLogError('');
    async function read() {
      try {
        const result = await fetchJson<ProcessLog>(`/api/processes/${openLog}/logs?after=${cursor}`, undefined, ProcessLogSchema);
        if (cancelled) return;
        if (!result.available) setLogError('日志暂不可用，正在重试。');
        else { setLogError(''); cursor = result.cursor; setLog((previous) => result.unchanged && previous ? previous : result); }
      } catch (error) { if (!cancelled) setLogError(error instanceof Error ? error.message : '日志读取失败。'); }
      finally { if (!cancelled) timer = setTimeout(() => void read(), 2000); }
    }
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, openLog]);

  useEffect(() => {
    if (data && openLog && !data.processes.some(item => item.processId === openLog && isActiveManagedProcess(item))) setOpenLog(null);
  }, [data, openLog]);

  async function submitStop(input: StopConfirmation) {
    // 行内确认固定原预览版本与命令身份；响应丢失后的重试仍由服务端幂等核对。
    try {
      if (input.scope === 'session') {
        await fetchJson(`/api/processes/sessions/${input.preview.process.sessionId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: input.commandId }) }, ProcessSessionStopReceiptSchema);
        return;
      }
      await fetchJson(`/api/processes/${input.processId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: input.commandId, revision: input.preview.process.revision, taskRevision: input.preview.taskRevision, confirmed: true }) }, ProcessStopReceiptSchema);
    } finally { void store.refresh(); }
  }
  async function requestStop(item: ProcessListItem, trigger: HTMLButtonElement) {
    if (lock.current) return;
    lock.current = true; stopTrigger.current = trigger; setPending(item.processId); setFailure(''); setConfirmation(null);
    try {
      const preview = await fetchJson<ProcessPreview>(`/api/processes/${item.processId}/stop-preview`, undefined, ProcessPreviewSchema);
      const input = { processId: item.processId, name: item.name, sourceTitle: item.taskTitle ?? '来源任务', preview, commandId: crypto.randomUUID(), error: '' };
      if (preview.needsConfirmation) setConfirmation(input);
      else { await submitStop(input); restoreFocus(item.processId); }
    } catch (error) { setFailure(error instanceof Error ? error.message : '停止结果尚未确认。'); }
    finally { lock.current = false; setPending(null); }
  }
  function requestSessionStop(item: ProcessListItem, trigger: HTMLButtonElement) {
    if (lock.current) return;
    stopTrigger.current = trigger; setFailure('');
    setConfirmation({ processId: item.processId, name: item.sessionTitle ?? '工作会话', commandId: crypto.randomUUID(), error: '', scope: 'session',
      preview: { process: item, taskRevision: null, needsConfirmation: true, impact: '这将结束该会话当前执行，并停止该会话全部托管进程。其他会话不受影响。' } });
  }
  async function confirmStop(input: StopConfirmation) {
    if (lock.current) return;
    lock.current = true; setPending(input.processId);
    try { await submitStop(input); setConfirmation(null); restoreFocus(input.processId); }
    catch (error) { setConfirmation(current => current?.commandId === input.commandId ? { ...current, error: error instanceof Error ? error.message : '停止结果尚未确认。' } : current); }
    finally { lock.current = false; setPending(null); }
  }

  // 进程移出活跃列表后，仍保留待核对的原停止请求，支持失去响应后的重试。
  function renderConfirmation(input: StopConfirmation) {
    return <div className="process-confirm" role="alert" aria-label={`停止「${input.name}」`} aria-busy={pending === input.processId}>
          <CircleAlert aria-hidden="true" />
          <div className="process-confirm-copy"><p><strong>{confirmationDetached ? `核对「${input.name}」的原停止请求。` : input.scope === 'session' ? `结束「${input.name}」的运行。` : `「${input.sourceTitle ?? '来源任务'}」仍在使用这个进程。`}</strong>{input.preview.impact}</p>{input.error && <p className="process-confirm-error" role="alert">{input.error}</p>}</div>
          <div className="run-row-actions">
            <button ref={cancelButton} className="secondary-button compact" disabled={pending !== null} onClick={() => cancelStop(input.processId)}>取消</button>
            <button className="secondary-button compact danger" disabled={pending !== null} onClick={() => void confirmStop(input)}>{pending === input.processId && <LoaderCircle className="spin" aria-hidden="true" />}{input.scope === 'session' ? '结束会话运行' : '仍然停止'}</button>
          </div>
        </div>;
  }

  return <section ref={section} tabIndex={-1} className="run-section" aria-label="后台进程" aria-busy={loading}>
    <div className="run-section-heading"><h2>后台进程</h2><span>由工作会话或任务启动的托管进程</span></div>
    {error && <p role="alert">{error}<button className="secondary-button compact" onClick={() => void store.refresh()}>重试</button></p>}
    {failure && <p role="alert">{failure}</p>}
    {items.map((item) => {
      const logOpen = openLog === item.processId;
      const confirming = confirmation?.processId === item.processId ? confirmation : null;
      return <article className="process-row" key={item.processId} data-process-id={item.processId}>
        <div className="process-main">
          <span className={`process-dot ${item.state}`} aria-hidden="true" />
          <div className="process-name">
            <strong title={item.name}>{item.name}</strong>{item.mode === 'foreground' && <small>前台执行</small>}<code title={item.command}>{item.command}</code>
            {item.state !== 'running' && <small title={item.reason}>{LABELS[item.state]} · {item.reason}</small>}
          </div>
          <dl className="run-row-facts">
            <div><dt>端口</dt><dd>{item.port ?? <span title="尚无已核对的监听端口">—</span>}</dd></div>
            <div><dt>已运行</dt><dd>{item.startedAt ? durationLabel((item.endedAt ? Date.parse(item.endedAt) : now) - Date.parse(item.startedAt)) : '尚未启动'}</dd></div>
            <div><dt>启动者</dt><dd>{item.taskAvailable ? <button className="inline-link" title={item.taskTitle ?? undefined} onClick={() => onOpenTask(item.taskId!)}>{item.taskTitle}</button> : item.taskId ? <span>来源任务已不可用</span> : item.sessionAvailable ? <button className="inline-link" onClick={() => onOpenSession(item.sessionId)}>{item.sessionTitle ?? '工作会话'}</button> : <span>来源会话已不可用</span>}{item.taskId && !item.taskRunning && !['exited', 'failed'].includes(item.state) && <small>任务不在执行</small>}</dd></div>
          </dl>
          <div className="run-row-actions">
            <button className={`secondary-button compact process-log-toggle${logOpen ? ' active' : ''}`} aria-expanded={logOpen} onClick={() => setOpenLog(logOpen ? null : item.processId)}><FileText aria-hidden="true" />日志</button>
            {!['exited', 'failed'].includes(item.state) && <button className="secondary-button compact danger" disabled={pending !== null || !!confirming || item.state === 'stopping'} onClick={event => void requestStop(item, event.currentTarget)}><CircleStop aria-hidden="true" />{pending === item.processId ? '处理中…' : item.state === 'stopping' ? '停止中' : '停止'}</button>}
            {!item.taskId && !['exited', 'failed'].includes(item.state) && <button className="secondary-button compact" disabled={pending !== null || !!confirmation} onClick={event => requestSessionStop(item, event.currentTarget)}>结束会话运行</button>}
          </div>
        </div>
        {confirming && renderConfirmation(confirming)}
        {logOpen && <div className="process-log-box">
          {logError && <p className="process-log-notice" role="alert">{logError}</p>}
          {log?.truncated && <p className="process-log-notice">较早日志已截断，仅显示最近的完整行。</p>}
          <pre className="process-log" aria-label={`${item.name} 日志尾部`}>{log?.text || (log ? '尚无完整日志行。' : '正在读取日志…')}</pre>
        </div>}
      </article>;
    })}
    {confirmation && confirmationDetached && <aside data-process-id={confirmation.processId} aria-label="停止结果核对">
      {renderConfirmation(confirmation)}
    </aside>}
    {data?.total === 0 && !confirmation && <div className="empty-state run-empty">
      <Server aria-hidden="true" />
      <h3>没有正在运行的托管进程</h3>
      <p>会话或任务启动的开发服务器等长驻进程会出现在这里，可以查看日志或停止。</p>
    </div>}
    {data && (offset > 0 || data.nextOffset !== null) && <div className="run-row-actions run-pagination">
      <button className="secondary-button compact" disabled={loading || !offset} onClick={() => void store.refresh(Math.max(0, offset - 100))}>上一页进程</button>
      <button className="secondary-button compact" disabled={loading || data.nextOffset === null} onClick={() => void store.refresh(data.nextOffset!)}>下一页进程</button>
    </div>}
  </section>;
}
