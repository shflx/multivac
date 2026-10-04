import { useEffect, useRef, useState } from 'react';
import { CircleStop, FileText } from 'lucide-react';
import { ProcessPreviewSchema, ProcessLogSchema, ProcessStopReceiptSchema, type ProcessPreview, type ProcessLog, type ProcessListItem } from '@multivac/contracts';
import { fetchJson } from '../../data/assistant-api.js';
import { useConfirm } from '../../components/confirm-card.js';
import { useProcesses } from './runs-provider.js';

const LABELS = { starting: '启动中', running: '运行中', stopping: '停止中', exited: '已退出', failed: '失败', recovery: '恢复核对' };
export function ProcessesSection({ active, onOpenTask }: { active: boolean; onOpenTask: (id: string) => void }) {
  const { store, data, error, loading, offset } = useProcesses();
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [log, setLog] = useState<ProcessLog | null>(null);
  const [logError, setLogError] = useState('');
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const lock = useRef(false);
  const confirm = useConfirm();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
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
  async function stop(item: ProcessListItem) {
    if (lock.current) return;
    lock.current = true; setPending(item.processId); setFailure('');
    try {
      const preview = await fetchJson<ProcessPreview>(`/api/processes/${item.processId}/stop-preview`, undefined, ProcessPreviewSchema);
      const commandId = crypto.randomUUID();
      const action = async () => {
        try { await fetchJson(`/api/processes/${item.processId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, revision: preview.process.revision, taskRevision: preview.taskRevision, confirmed: true }) }, ProcessStopReceiptSchema); }
        finally { void store.refresh(); }
      };
      if (preview.needsConfirmation) await confirm({ title: `停止「${item.name}」`, description: preview.impact, tone: 'danger', confirmLabel: '仍然停止', action });
      else await action();
    } catch (error) { setFailure(error instanceof Error ? error.message : '停止结果尚未确认。'); }
    finally { lock.current = false; setPending(null); }
  }
  return <section className="run-section" aria-label="后台进程" aria-busy={loading}>
    <div className="run-section-heading"><h2>后台进程</h2><span>只显示由任务启动的进程</span></div>
    {error && <p role="alert">{error}<button className="secondary-button compact" onClick={() => void store.refresh()}>重试</button></p>}
    {failure && <p role="alert">{failure}</p>}
    {data?.processes.map((item) => <article className="process-row" key={item.processId}>
      <div className="process-main">
        <span className={`process-dot ${item.state}`} aria-hidden="true" />
        <div className="process-name"><strong>{item.name}</strong><code>{item.command}</code><small>{LABELS[item.state]} · {item.reason}</small></div>
        <dl className="run-row-facts">
          <div><dt>端口</dt><dd>{item.port ?? '未知'}</dd></div>
          <div><dt>已运行</dt><dd>{item.startedAt ? `${Math.max(0, Math.floor(((item.endedAt ? Date.parse(item.endedAt) : now) - Date.parse(item.startedAt)) / 1000))} 秒` : '尚未启动'}</dd></div>
          <div><dt>启动任务</dt><dd>{item.taskAvailable ? <button className="run-row-title" onClick={() => onOpenTask(item.taskId)}>{item.taskTitle}</button> : <span>来源任务已不可用（{item.taskId}）</span>}{!item.taskRunning && !['exited', 'failed'].includes(item.state) && <small>任务不在执行，进程仍需独立核对</small>}</dd></div>
        </dl>
        <div className="run-row-actions">
          <button className="secondary-button compact" aria-expanded={openLog === item.processId} onClick={() => setOpenLog(openLog === item.processId ? null : item.processId)}><FileText aria-hidden="true" />日志</button>
          {!['exited', 'failed'].includes(item.state) && <button className="secondary-button compact danger" disabled={pending !== null || item.state === 'stopping'} onClick={() => void stop(item)}><CircleStop aria-hidden="true" />{pending === item.processId ? '处理中…' : item.state === 'stopping' ? '停止中' : '停止'}</button>}
        </div>
      </div>
      {openLog === item.processId && <div className="process-log-box">
        {logError && <p role="alert">{logError}</p>}
        <p>日志按纯文本呈现，敏感模式已遮蔽。{log?.truncated ? '内容已截断，仅展示最近 64 KiB 内的完整行。' : '仅展示已完整输出的行。'}</p>
        <pre className="process-log" aria-label={`${item.name} 日志尾部`}>{log?.text || '尚无完整日志行。'}</pre>
      </div>}
    </article>)}
    {data?.total === 0 && <p className="run-empty">没有由任务启动的后台进程。</p>}
    {data && (offset > 0 || data.nextOffset !== null) && <div className="run-row-actions">
      <button className="secondary-button compact" disabled={loading || !offset} onClick={() => void store.refresh(Math.max(0, offset - 100))}>上一页进程</button>
      <button className="secondary-button compact" disabled={loading || data.nextOffset === null} onClick={() => void store.refresh(data.nextOffset!)}>下一页进程</button>
    </div>}
  </section>;
}
