import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { runIndicatorState, RUN_STATE_LABELS } from '@multivac/contracts';
import { useRuns } from './runs-provider.js';

export function RunIndicator({ onViewRuns, onOpenSession, onOpenTask }: {
  onViewRuns?: (() => void) | undefined; onOpenSession: (id: string) => void; onOpenTask: (id: string) => void;
}) {
  const { data, error, store } = useRuns();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const state = data ? runIndicatorState(data.counts) : 'idle';
  const label = error ? '状态不可用' : !data ? '读取中' : { idle: '空闲', ok: '运行中', attention: '需要留意' }[state];
  const summary = data ? `${data.counts.running} 个执行中 · ${data.counts.queued} 个排队 · ${data.counts.anomalies} 项需留意 · ${data.counts.waiting} 项等待用户 · ${data.counts.processesRunning ?? 0} 个后台进程` : '正在读取运行事实';
  function close(restore = true) { setOpen(false); if (restore) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    popover.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) close(!(event.target instanceof Element && event.target.closest('button,a,input,textarea,select,[tabindex]')));
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); };
  }, [open]);
  const groups = [
    { title: '需要留意', items: data?.highlights.filter((item) => item.anomaly) ?? [] },
    { title: '执行中', items: data?.highlights.filter((item) => ['preparing', 'running', 'stopping'].includes(item.state)) ?? [] },
  ];
  return <div className="run-indicator-root" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className={`run-indicator ${error ? 'unknown' : state}`} title={summary} aria-label={`${label}：${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : setOpen(true)}>
      <span className="run-indicator-dot" aria-hidden="true" />{label}
    </button>
    {open && <div id={id} ref={popover} className="run-popover" role="dialog" aria-label="运行状态" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <header><strong>{label}</strong><span>{summary}</span></header>
      {error ? <p role="alert">{error}<button onClick={() => void store.refresh()}>重试</button></p> : <>
        {groups.filter((group) => group.items.length).map((group) => <section key={group.title} aria-label={group.title}><h3>{group.title}</h3>
          {group.items.slice(0, 5).map((item) => <button className="run-popover-row" key={item.taskId} onClick={() => {
            close(false); if (item.sessionAvailable && item.sessionId) onOpenSession(item.sessionId); else onOpenTask(item.taskId);
          }}><span><strong>{item.title}</strong><small>{RUN_STATE_LABELS[item.state]} · {item.reason}</small></span><ArrowRight aria-hidden="true" /></button>)}
        </section>)}
        {!!data?.counts.processesRecovery && <p>{data.counts.processesRecovery} 个后台进程停止事实待核对，资源占用仍保留。</p>}
        {!!data?.counts.processesRunning && <p>后台进程仍在运行；任务结束不代表进程退出。</p>}
        {!!data?.counts.queued && <p>{data.counts.queued} 个任务正在等待依赖、预算或执行资源，尚未开始执行。</p>}
        {data && !data.counts.running && !data.counts.anomalies && !data.counts.queued && !data.counts.processesRunning && !data.counts.processesRecovery && <p>{data.counts.waiting ? '任务正在等待用户回应，不属于运行异常。' : '没有执行中的任务。'}</p>}
        {data && data.total > 5 && <p>浮层仅展示部分任务，完整状态请到运行页查看。</p>}
      </>}
      {onViewRuns && <footer><button className="run-popover-row" onClick={() => { close(false); onViewRuns(); }}>在管理中查看<ArrowRight aria-hidden="true" /></button></footer>}
    </div>}
  </div>;
}
