import { useEffect, useRef, useState } from 'react';
import { Activity, CircleAlert, LoaderCircle, MessageSquare, Pause, Terminal } from 'lucide-react';
import { type RunSnapshot } from '@multivac/contracts';
import { activeRunStates, durationLabel, recentToolAge, runStateLabel } from './run-presentation.js';
import { useRuns } from './runs-provider.js';
import { useTasks } from '../tasks/tasks-provider.js';

export function runElapsed(item: RunSnapshot, observedAt: string, now: number): string {
  if (item.elapsedMs === null) return item.startedAt ? '未知' : '尚未开始';
  const elapsed = item.elapsedMs + (item.endedAt ? 0 : Math.max(0, now - Date.parse(observedAt)));
  return durationLabel(elapsed);
}
export function RunsPage({ active, onOpenTask, onOpenSession, children }: {
  active: boolean; onOpenTask: (id: string) => void; onOpenSession: (id: string) => void; children?: React.ReactNode;
}) {
  const { data, loading, error, store } = useRuns();
  const tasks = useTasks();
  const lock = useRef(new Set<string>());
  const [pending, setPending] = useState<string[]>([]);
  const [failure, setFailure] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    void store.refresh();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, store]);
  async function pause(item: RunSnapshot) {
    if (!tasks.store || lock.current.has(item.taskId)) return;
    lock.current.add(item.taskId); setPending([...lock.current]); setFailure('');
    try { await tasks.store.control(item, 'pause'); }
    catch (error) { setFailure(error instanceof Error ? error.message : '暂停结果尚未确认，请核对运行状态。'); }
    finally { lock.current.delete(item.taskId); setPending([...lock.current]); void store.refresh(); }
  }
  return <div className="runs-page">
    {error && <p role="alert">{error} <button className="secondary-button compact" onClick={() => void store.refresh()}>重试</button></p>}
    {failure && <p role="alert">{failure}</p>}
    <section className="run-section" aria-label="任务会话" aria-busy={loading}>
      <div className="run-section-heading"><h2>任务会话</h2><span>{data ? `${data.counts.running} 个执行中` : '读取中…'}</span></div>
      {data?.items.filter(item => activeRunStates.has(item.state)).map((item) => <article key={item.taskId} className={`run-row ${item.anomaly ? 'stalled' : ''}`}>
        {item.anomaly ? <CircleAlert className="run-row-mark" aria-hidden="true" /> : <LoaderCircle className="run-row-mark running spin" aria-hidden="true" />}
        <div className="run-row-main">
          <div><button className="run-row-title" title={item.title} disabled={!item.taskAvailable} onClick={() => onOpenTask(item.taskId)}>{item.title}</button>{(item.anomaly || !activeRunStates.has(item.state)) && <span className={item.anomaly ? 'run-stalled' : 'run-state'}>{runStateLabel(item)}</span>}</div>
          <p title={item.reason}>{item.reason}</p>
        </div>
        <dl className="run-row-facts">
          <div><dt>已用时</dt><dd>{runElapsed(item, data.observedAt, now)}</dd></div>
          <div><dt>最近工具</dt><dd><Terminal aria-hidden="true" /><span title={item.lastTool ?? undefined}>{item.lastTool ?? '尚无工具调用'}</span>{item.lastToolAt && <small title={new Date(item.lastToolAt).toLocaleString()}>{recentToolAge(item.lastToolAt, now)}</small>}</dd></div>
        </dl>
        <div className="run-row-actions">
          {item.canPause && <button className="secondary-button compact" disabled={pending.includes(item.taskId)} onClick={() => void pause(item)}><Pause aria-hidden="true" />{pending.includes(item.taskId) ? '提交中…' : '暂停'}</button>}
          {item.sessionAvailable && item.sessionId && <button className="secondary-button compact" onClick={() => onOpenSession(item.sessionId!)}><MessageSquare aria-hidden="true" />进入现场</button>}
        </div>
      </article>)}
      {!loading && data?.total === 0 && <div className="empty-state run-empty">
        <Activity aria-hidden="true" />
        <h3>没有正在运行的任务会话</h3>
        <p>启动的任务会出现在这里，显示已用时与最近工具，可以随时暂停或进入现场。</p>
      </div>}
      {data && (store.snapshot().offset > 0 || data.nextOffset !== null) && <div className="run-row-actions">
        <button className="secondary-button compact" disabled={loading || store.snapshot().offset === 0} onClick={() => void store.refresh(Math.max(0, store.snapshot().offset - 100))}>上一页</button>
        <button className="secondary-button compact" disabled={loading || data.nextOffset === null} onClick={() => void store.refresh(data.nextOffset!)}>下一页</button>
      </div>}
    </section>
    {children}
  </div>;
}
