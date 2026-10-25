import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { useProcesses, useRuns } from './runs-provider.js';
import { activeRunStates, RunStateBadge } from './run-presentation.js';
import { runIndicatorView } from './run-indicator-state.js';
import { TaskIconButton } from '../tasks/task-icon-button.js';

type Navigation = {
  onViewRuns?: (() => void) | undefined; onOpenSession: (id: string) => void; onOpenTask: (id: string) => void;
};

export function RunIndicator({ onViewRuns, onOpenSession, onOpenTask }: Navigation) {
  const runs = useRuns();
  const processes = useProcesses();
  const { state, label, summary, error, checking } = runIndicatorView(runs, processes);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), popover = useRef<HTMLDivElement>(null);
  const id = useId();
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
  return <div className="run-indicator-root" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <TaskIconButton className={`run-indicator ${error || checking ? 'unknown' : state}`} label={`${label}：${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { if (open) close(); else { setOpen(true); void runs.store.refresh(); void processes.store.refresh(); } }}>
      <span className="run-indicator-dot" aria-hidden="true" /><span>{label}</span>
    </TaskIconButton>
    {open && <div id={id} ref={popover} className="run-popover" role="dialog" aria-label="运行状态" aria-busy={runs.loading || processes.loading} onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <RunIndicatorContent runs={runs} processes={processes} onClose={() => close(false)} onViewRuns={onViewRuns} onOpenSession={onOpenSession} onOpenTask={onOpenTask} />
    </div>}
  </div>;
}

/** 弹层独立呈现两路读取状态，任一路失败时仍保留已确认的明细。 */
export function RunIndicatorContent({ runs, processes, onClose, onViewRuns, onOpenSession, onOpenTask }: Navigation & {
  runs: ReturnType<typeof useRuns>; processes: ReturnType<typeof useProcesses>; onClose: () => void;
}) {
  const { data, error, store } = runs;
  const { state, label, summary, counts, activeProcesses, empty, checking, error: statusError } = runIndicatorView(runs, processes);
  const groups = [
    { title: '异常', items: data?.highlights.filter((item) => item.anomaly && activeRunStates.has(item.state)) ?? [] },
    { title: '执行中', items: data?.highlights.filter((item) => !item.anomaly && activeRunStates.has(item.state)) ?? [] },
  ];
  return <>
    <header><strong>{label}</strong>{(state !== 'idle' || checking || statusError) && <span>{summary}</span>}</header>
    {((!data && !error) || (runs.loading && error)) && <p role="status">{data ? '正在核对任务运行状态，暂时保留上次确认结果。' : '正在读取任务运行状态…'}</p>}
    {((!processes.overview && !processes.error) || (processes.loading && processes.error)) && <p role="status">{processes.overview ? '正在核对进程状态，暂时保留上次确认结果。' : '正在读取进程明细…'}</p>}
    {error && <p role="alert">{error}{data && ' 当前任务信息为上次确认结果。'}<button type="button" className="inline-link" onClick={() => void store.refresh()}>重试任务状态</button></p>}
    {processes.error && <p role="alert">{processes.error}{processes.overview && ' 当前进程信息为上次确认结果。'}<button type="button" className="inline-link" onClick={() => void processes.store.refresh()}>重试进程状态</button></p>}
    {groups.filter((group) => group.items.length).map((group) => <section key={group.title} aria-label={group.title}><h3>{group.title}</h3>
      {group.items.slice(0, 5).map((item) => <button className="run-popover-row" key={item.taskId} onClick={() => {
        onClose(); if (item.sessionAvailable && item.sessionId) onOpenSession(item.sessionId); else onOpenTask(item.taskId);
      }}><RunStateBadge item={item} /><span className="run-popover-text"><strong title={item.title}>{item.title}</strong><small title={item.reason}>{item.reason}</small></span><ArrowRight aria-hidden="true" /></button>)}
    </section>)}
    {processes.overview && !empty && <section aria-label="进程"><h3>进程（{counts.processesRunning}）</h3>
      {activeProcesses.slice(0, 5).map(item => <button className="run-popover-row" key={item.processId} onClick={() => {
        onClose();
        if (item.taskAvailable && item.taskId) onOpenTask(item.taskId);
        else if (item.sessionAvailable) onOpenSession(item.sessionId);
        else onViewRuns?.();
      }} disabled={!item.taskAvailable && !item.sessionAvailable && !onViewRuns}>
        <span className="run-state-badge running"><LoaderCircle className="spin" aria-hidden="true" />{item.state === 'starting' ? '启动中' : item.state === 'stopping' ? '停止中' : '运行中'}</span>
        <span className="run-popover-text"><strong title={item.name}>{item.name}</strong><small>{[item.mode === 'foreground' ? '前台执行' : '', item.taskTitle ?? item.sessionTitle ?? '工作会话', item.port ? `端口 ${item.port}` : ''].filter(Boolean).join(' · ')}</small></span><ArrowRight aria-hidden="true" />
      </button>)}
      {!counts.processesRunning && <p className="run-popover-empty">{processes.error ? '上次确认时没有活跃进程。' : '没有活跃进程。'}</p>}
      {counts.processesRunning > 5 && <p className="run-popover-empty">显示前 5 个活跃进程，共 {counts.processesRunning} 个；完整列表可在运行页查看。</p>}
    </section>}
    {!!counts.processesRecovery && <p role="status">{counts.processesRecovery} 个进程正在恢复核对，停止状态尚未确认。</p>}
    {empty && <p className="run-popover-empty">没有运行中的任务会话或进程。</p>}
    {data && data.total > data.highlights.length && <p className="run-popover-empty">更多运行项可在运行页查看。</p>}
    {onViewRuns && <footer><button className="inline-link" onClick={() => { onClose(); onViewRuns(); }}>在管理中查看<ArrowRight aria-hidden="true" /></button></footer>}
  </>;
}
