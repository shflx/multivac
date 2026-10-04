import { useEffect, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, MessageSquare, Pause, Terminal } from 'lucide-react';
import { RUN_STATE_LABELS, type RunSnapshot } from '@multivac/contracts';
import { useRuns } from './runs-provider.js';
import { useTasks } from '../tasks/tasks-provider.js';

export function runElapsed(item: RunSnapshot, observedAt: string, now: number): string {
  if (item.elapsedMs === null) return item.startedAt ? '未知' : '尚未开始';
  const elapsed = item.elapsedMs + (item.endedAt ? 0 : Math.max(0, now - Date.parse(observedAt)));
  const seconds = Math.floor(elapsed / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
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
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  async function pause(item: RunSnapshot) {
    if (!tasks.store || lock.current.has(item.taskId)) return;
    lock.current.add(item.taskId); setPending([...lock.current]); setFailure('');
    try { await tasks.store.control(item, 'pause'); }
    catch (error) { setFailure(error instanceof Error ? error.message : '暂停结果尚未确认，请核对运行状态。'); }
    finally { lock.current.delete(item.taskId); setPending([...lock.current]); void store.refresh(); }
  }
  return <div className="runs-page">
    <p className="runs-intro">此刻在执行的任务会话和由任务启动的后台进程。</p>
    {error && <p role="alert">{error} <button className="secondary-button compact" onClick={() => void store.refresh()}>重试</button></p>}
    {failure && <p role="alert">{failure}</p>}
    <section className="run-section" aria-label="任务会话" aria-busy={loading}>
      <div className="run-section-heading"><h2>任务会话</h2><span>{data ? `${data.counts.running} 个执行中 · ${data.counts.queued} 个排队` : '读取中…'}</span></div>
      {data?.items.map((item) => <article key={item.taskId} className={`run-row ${item.anomaly ? 'stalled' : ''}`}>
        {item.anomaly ? <CircleAlert className="run-row-mark" aria-hidden="true" /> : <LoaderCircle className="run-row-mark" aria-hidden="true" />}
        <div className="run-row-main">
          <div><button className="run-row-title" disabled={!item.taskAvailable} onClick={() => onOpenTask(item.taskId)}>{item.title}</button><span className="run-state">{RUN_STATE_LABELS[item.state]}</span></div>
          <p>{item.reason}</p>
          {item.state === 'queued' && <small>{item.nextStep || '等待依赖、预算与执行资源满足条件，尚未开始执行。'}</small>}
        </div>
        <dl className="run-row-facts">
          <div><dt>已用时</dt><dd>{runElapsed(item, data.observedAt, now)}</dd></div>
          <div><dt>最近工具</dt><dd><Terminal aria-hidden="true" />{item.lastTool ?? '尚无工具记录'}{item.lastToolAt && <small>{new Date(item.lastToolAt).toLocaleTimeString()}</small>}</dd></div>
        </dl>
        <div className="run-row-actions">
          {item.canPause && <button className="secondary-button compact" disabled={pending.includes(item.taskId)} onClick={() => void pause(item)}><Pause aria-hidden="true" />{pending.includes(item.taskId) ? '提交中…' : '暂停'}</button>}
          {item.sessionAvailable && item.sessionId && <button className="secondary-button compact" onClick={() => onOpenSession(item.sessionId!)}><MessageSquare aria-hidden="true" />进入现场</button>}
        </div>
      </article>)}
      {!loading && data?.total === 0 && <p className="run-empty">没有正在执行或需要留意的任务。</p>}
      {data && (store.snapshot().offset > 0 || data.nextOffset !== null) && <div className="run-row-actions">
        <button className="secondary-button compact" disabled={loading || store.snapshot().offset === 0} onClick={() => void store.refresh(Math.max(0, store.snapshot().offset - 100))}>上一页</button>
        <button className="secondary-button compact" disabled={loading || data.nextOffset === null} onClick={() => void store.refresh(data.nextOffset!)}>下一页</button>
      </div>}
    </section>
    {children}
  </div>;
}
