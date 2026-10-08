import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { runIndicatorState } from '@multivac/contracts';
import { useRuns } from './runs-provider.js';
import { activeRunStates, RunStateBadge, runSummary } from './run-presentation.js';
import { TaskIconButton } from '../tasks/task-icon-button.js';

export function RunIndicator({ onViewRuns, onOpenSession, onOpenTask }: {
  onViewRuns?: (() => void) | undefined; onOpenSession: (id: string) => void; onOpenTask: (id: string) => void;
}) {
  const { data, error, store } = useRuns();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const state = data ? runIndicatorState(data.counts) : 'idle';
  const label = error ? '状态不可用' : !data ? '读取中' : { idle: '空闲', ok: '运行中', attention: '需要留意' }[state];
  const summary = data ? runSummary(data.counts) : '正在读取运行事实';
  function close(restore = true) { setOpen(false); if (restore) root.current?.querySelector<HTMLButtonElement>('.run-indicator')?.focus(); }
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
    { title: '异常', items: data?.highlights.filter((item) => item.anomaly) ?? [] },
    { title: '执行中', items: data?.highlights.filter((item) => !item.anomaly && activeRunStates.has(item.state)) ?? [] },
  ];
  return <div className="run-indicator-root" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <TaskIconButton className={`run-indicator ${error ? 'unknown' : state}`} label={`${label}：${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => open ? close() : setOpen(true)}>
      <span className="run-indicator-dot" aria-hidden="true" /><span>{label}</span>
    </TaskIconButton>
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
          }}><RunStateBadge item={item} /><span className="run-popover-text"><strong title={item.title}>{item.title}</strong><small title={item.reason}>{item.reason}</small></span><ArrowRight aria-hidden="true" /></button>)}
        </section>)}
        {!!data?.counts.processesRecovery && <p className="run-popover-empty">{data.counts.processesRecovery} 个后台进程停止事实待核对。</p>}
        {!!data?.counts.queued && <p className="run-popover-empty">{data.counts.queued} 个任务正在等待依赖、预算或执行资源，尚未开始执行。</p>}
        {data && !data.counts.running && !data.counts.anomalies && !data.counts.queued && !data.counts.processesRunning && !data.counts.processesRecovery && <p className="run-popover-empty">没有执行中的任务。</p>}
        {data && data.highlights.length > 0 && data.total > data.highlights.length && <p className="run-popover-empty">更多任务可在运行页查看。</p>}
      </>}
      {onViewRuns && <footer><button className="inline-link" onClick={() => { close(false); onViewRuns(); }}>在管理中查看<ArrowRight aria-hidden="true" /></button></footer>}
    </div>}
  </div>;
}
