import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { isActiveManagedProcess, runIndicatorState } from '@multivac/contracts';
import { useProcesses, useRuns } from './runs-provider.js';
import { activeRunStates, RunStateBadge, runSummary } from './run-presentation.js';
import { TaskIconButton } from '../tasks/task-icon-button.js';

export function RunIndicator({ onViewRuns, onOpenSession, onOpenTask }: {
  onViewRuns?: (() => void) | undefined; onOpenSession: (id: string) => void; onOpenTask: (id: string) => void;
}) {
  const { data, error, store } = useRuns();
  const processes = useProcesses();
  const activeProcesses = processes.data?.processes.filter(isActiveManagedProcess) ?? [];
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
    { title: '异常', items: data?.highlights.filter((item) => item.anomaly && activeRunStates.has(item.state)) ?? [] },
    { title: '执行中', items: data?.highlights.filter((item) => !item.anomaly && activeRunStates.has(item.state)) ?? [] },
  ];
  return <div className="run-indicator-root" ref={root} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <TaskIconButton className={`run-indicator ${error ? 'unknown' : state}`} label={`${label}：${summary}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { if (open) close(); else { setOpen(true); void store.refresh(); void processes.store.refresh(); } }}>
      <span className="run-indicator-dot" aria-hidden="true" /><span>{label}</span>
    </TaskIconButton>
    {open && <div id={id} ref={popover} className="run-popover" role="dialog" aria-label="运行状态" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <header><strong>{label}</strong>{data && !error && state !== 'idle' && <span>{summary}</span>}</header>
      {error ? <p role="alert">{error}<button onClick={() => void store.refresh()}>重试</button></p> : <>
        {groups.filter((group) => group.items.length).map((group) => <section key={group.title} aria-label={group.title}><h3>{group.title}</h3>
          {group.items.slice(0, 5).map((item) => <button className="run-popover-row" key={item.taskId} onClick={() => {
            close(false); if (item.sessionAvailable && item.sessionId) onOpenSession(item.sessionId); else onOpenTask(item.taskId);
          }}><RunStateBadge item={item} /><span className="run-popover-text"><strong title={item.title}>{item.title}</strong><small title={item.reason}>{item.reason}</small></span><ArrowRight aria-hidden="true" /></button>)}
        </section>)}
        {activeProcesses.length > 0 && <section aria-label="进程"><h3>进程</h3>
          {activeProcesses.slice(0, 5).map(item => <button className="run-popover-row" key={item.processId} onClick={() => {
            close(false);
            if (item.taskAvailable && item.taskId) onOpenTask(item.taskId);
            else if (item.sessionAvailable) onOpenSession(item.sessionId);
            else onViewRuns?.();
          }} disabled={!item.taskAvailable && !item.sessionAvailable && !onViewRuns}>
            <span className="run-state-badge running"><LoaderCircle className="spin" aria-hidden="true" />{item.state === 'starting' ? '启动中' : item.state === 'stopping' ? '停止中' : '运行中'}</span>
            <span className="run-popover-text"><strong title={item.name}>{item.name}</strong><small>{[item.mode === 'foreground' ? '前台执行' : '', item.taskTitle ?? item.sessionTitle ?? '工作会话', item.port ? `端口 ${item.port}` : ''].filter(Boolean).join(' · ')}</small></span><ArrowRight aria-hidden="true" />
          </button>)}
        </section>}
        {processes.error && <p role="alert">{processes.error}<button onClick={() => void processes.store.refresh()}>重试</button></p>}
        {data && !data.counts.running && !data.counts.processesRunning && <p className="run-popover-empty">没有运行中的任务会话或进程。</p>}
        {data && (data.total > data.highlights.length || (processes.data?.total ?? 0) > 5) && <p className="run-popover-empty">更多运行项可在运行页查看。</p>}
      </>}
      {onViewRuns && <footer><button className="inline-link" onClick={() => { close(false); onViewRuns(); }}>在管理中查看<ArrowRight aria-hidden="true" /></button></footer>}
    </div>}
  </div>;
}
