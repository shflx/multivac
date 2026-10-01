import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert, CircleDashed, CircleHelp, FileText, Folder, GripVertical, List, LoaderCircle, Columns3, MessageSquare, Pause, Play, Search, X } from 'lucide-react';
import { TASK_COLUMNS, presentTask, filterPanelTasks, splitCompleted, visibleSelectedId, taskDropAction, orderTasks, reorderTasks } from './task-panel-state.js';

function TaskActions({ task, state, onStart, onPause, onRequest, onSession, onOutput, onSelect, compact = false, IconButton }) {
  if (compact) {
    if (state.request) return <IconButton label={state.waitLabel === '验收' ? '查看成果并验收' : '处理请求'} onClick={() => onRequest(task)}>{state.waitLabel === '验收' ? <CheckCircle2 /> : <CircleHelp />}</IconButton>;
    if (state.abnormal) return <><IconButton label="查看原因" onClick={() => onSelect(task.id)}><CircleAlert /></IconButton><IconButton label="进入现场" onClick={() => onSession(task)}><MessageSquare /></IconButton></>;
    if (state.column === 'running') return <IconButton label="暂停" onClick={() => onPause(task)}><Pause /></IconButton>;
    if (['idle', 'paused'].includes(state.column)) return <IconButton label={state.column === 'paused' ? '继续' : '启动'} onClick={() => onStart(task.id)}><Play /></IconButton>;
    return onOutput ? <IconButton label="查看成果" onClick={onOutput}><FileText /></IconButton> : null;
  }
  if (state.request) return <button className="inline-link" onClick={() => onRequest(task)}>{state.waitLabel === '验收' ? <CheckCircle2 /> : <CircleAlert />}{state.waitLabel === '验收' ? '查看成果并验收' : '处理请求'}</button>;
  if (state.abnormal) return <><button className="inline-link" onClick={() => onSelect(task.id)}><CircleAlert />查看原因</button><button className="inline-link" onClick={() => onSession(task)}><MessageSquare />进入现场</button></>;
  if (state.column === 'running') return <button className="inline-link" onClick={() => onPause(task)}><Pause />暂停</button>;
  if (state.column === 'idle' || state.column === 'paused') return <button className="inline-link" onClick={() => onStart(task.id)}><Play />{state.column === 'paused' ? '继续' : '启动'}</button>;
  if (state.column === 'done') return onOutput ? <button className="inline-link" onClick={onOutput}><FileText />查看成果</button> : <span className="task-panel-muted">暂无成果文件</span>;
  return <button className="inline-link" onClick={() => onSession(task)}><MessageSquare />进入现场</button>;
}

export function TaskPanel({ tasks, projects, requests, outputs, selectedId, onSelect, updateTask, onStart, onRequest, onSession, onOutput, directoryOf, IconButton }) {
  const [view, setView] = useState(() => window.localStorage.getItem('multivac.prototype.task-view') === 'board' ? 'board' : 'list');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [status, setStatus] = useState('unfinished');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [order, setOrder] = useState(() => {
    try { const saved = JSON.parse(window.localStorage.getItem('multivac.prototype.task-order')); return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []; } catch { return []; }
  });
  const [draggedId, setDraggedId] = useState(null);
  const [dropMark, setDropMark] = useState(null);
  const [notice, setNotice] = useState('');
  const drag = useRef(null);
  const placement = useRef(null);
  const keyboardDrag = useRef(false);
  const dropped = useRef(false);
  const surface = useRef(null);
  const pointer = useRef(null);
  useEffect(() => { window.localStorage.setItem('multivac.prototype.task-order', JSON.stringify(order)); }, [order]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { window.localStorage.setItem('multivac.prototype.task-view', view); }, [view]);
  const filtered = orderTasks(filterPanelTasks(tasks, requests, { query, project, status }), order);
  const completed = splitCompleted(filtered);
  const visible = filtered.filter((task) => task.status !== 'done' || historyOpen || query.trim() || completed.recent.includes(task));
  const validId = visibleSelectedId(selectedId, visible);
  const selected = visible.find((task) => task.id === validId);
  useEffect(() => { if (selectedId && !validId) onSelect(null); }, [selectedId, validId]);
  const projectName = (task) => projects.find((item) => item.id === task.projectId)?.name || '日常';
  const outputFor = (task) => outputs.find((item) => item.taskId === task.id);
  const pauseTask = (item) => updateTask(item.id, { status: 'paused', resumeNext: item.next, reason: '你已主动暂停，已有工作保留', next: '继续后恢复原步骤' });
  const actionsFor = (task) => ({ task, state: presentTask(task, requests), onStart, onPause: pauseTask, onRequest, onSession, onSelect, IconButton, onOutput: outputFor(task) ? () => onOutput(outputFor(task).id) : null });
  const sections = [...projects.map((item) => ({ id: item.id, name: item.name })), { id: 'daily', name: '日常' }].map((item) => ({ ...item, tasks: visible.filter((task) => (task.projectId || 'daily') === item.id) })).filter((item) => item.tasks.length);
  const draggedTask = tasks.find((task) => task.id === draggedId);

  useEffect(() => {
    if (!draggedId || keyboardDrag.current) return;
    let frame;
    function scrollAtEdge() {
      const element = surface.current;
      const point = pointer.current;
      if (element && point) {
        const rect = element.getBoundingClientRect();
        if (point.y >= rect.top && point.y <= rect.bottom && point.x >= rect.left && point.x <= rect.right) {
          if (point.x < rect.left + 44) element.scrollLeft -= 12;
          if (point.x > rect.right - 44) element.scrollLeft += 12;
        }
      }
      frame = requestAnimationFrame(scrollAtEdge);
    }
    frame = requestAnimationFrame(scrollAtEdge);
    return () => cancelAnimationFrame(frame);
  }, [draggedId]);

  function markDrop(column, beforeId = null) {
    placement.current = { column, beforeId };
    setDropMark((current) => current?.column === column && current.beforeId === beforeId ? current : placement.current);
    if (keyboardDrag.current) surface.current?.querySelector(`.task-board-column.${column}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function beginDrag(task, event) {
    drag.current = task.id;
    dropped.current = false;
    keyboardDrag.current = false;
    setDraggedId(task.id);
    setNotice(`正在移动「${task.title}」`);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', task.id);
    const card = event.currentTarget.closest('[data-task-id]');
    if (card) {
      const rect = card.getBoundingClientRect();
      event.dataTransfer.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top);
    }
  }

  function endDrag() {
    const task = tasks.find((item) => item.id === drag.current);
    if (!dropped.current && task) {
      const action = placement.current ? taskDropAction(task, requests, placement.current.column) : null;
      setNotice(action?.kind === 'blocked' ? action.label : '拖动已取消');
    }
    drag.current = null;
    keyboardDrag.current = false;
    placement.current = null;
    pointer.current = null;
    setDraggedId(null);
    setDropMark(null);
  }

  function performDrop(column, beforeId) {
    const task = tasks.find((item) => item.id === drag.current);
    if (!task) return;
    const action = taskDropAction(task, requests, column);
    const restoreKeyboardFocus = keyboardDrag.current && action.kind !== 'request';
    dropped.current = true;
    if (action.kind === 'blocked') setNotice(action.label);
    else {
      if (action.kind !== 'request') setOrder((current) => reorderTasks(current, tasks.map((item) => item.id), task.id, beforeId));
      if (action.kind === 'start') onStart(task.id);
      if (action.kind === 'pause') pauseTask(task);
      if (action.kind === 'request') onRequest(task);
      setNotice(action.kind === 'request' ? '已打开原请求，处理后更新任务状态' : action.kind === 'reorder' ? '任务顺序已更新' : action.label === '启动任务' ? '任务已启动' : action.label === '暂停任务' ? '任务已暂停' : '任务已继续');
    }
    endDrag();
    if (restoreKeyboardFocus) requestAnimationFrame(() => [...(surface.current?.querySelectorAll('[data-task-id]') || [])].find((element) => element.dataset.taskId === task.id)?.querySelector('.task-drag-handle')?.focus());
  }

  function dragOver(event, column, beforeId = null) {
    const task = tasks.find((item) => item.id === drag.current);
    if (!task) return;
    event.preventDefault();
    event.stopPropagation();
    pointer.current = { x: event.clientX, y: event.clientY };
    event.dataTransfer.dropEffect = taskDropAction(task, requests, column).kind === 'blocked' ? 'none' : 'move';
    markDrop(column, beforeId);
  }

  function keyboardMove(event) {
    if (!keyboardDrag.current || !drag.current) return;
    const column = placement.current?.column;
    if (event.key === 'Escape') { event.preventDefault(); dropped.current = true; endDrag(); return; }
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); performDrop(column, placement.current?.beforeId); return; }
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index = TASK_COLUMNS.findIndex((item) => item.id === column);
      markDrop(TASK_COLUMNS[Math.max(0, Math.min(4, index + (event.key === 'ArrowRight' ? 1 : -1)))].id);
    }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const items = visible.filter((task) => presentTask(task, requests).column === column);
      const candidates = items.filter((task) => task.id !== drag.current);
      const before = placement.current?.beforeId;
      const index = before === drag.current ? Math.max(0, items.findIndex((task) => task.id === drag.current)) : before ? candidates.findIndex((task) => task.id === before) : candidates.length;
      const next = Math.max(0, Math.min(candidates.length, index + (event.key === 'ArrowDown' ? 1 : -1)));
      markDrop(column, candidates[next]?.id || null);
    }
  }

  useEffect(() => {
    if (draggedId && !visible.some((task) => task.id === draggedId)) {
      dropped.current = true;
      endDrag();
      setNotice('任务已移出当前结果，拖动已取消');
    }
  }, [draggedId, visible.some((task) => task.id === draggedId)]);

  return <div className={`task-panel ${view === 'board' ? 'board-mode' : ''} ${draggedId ? 'is-dragging' : ''}`} onKeyDown={keyboardMove}>
    <header className="task-panel-toolbar"><h1>待办</h1>
      <label className="task-panel-search"><Search /><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <select aria-label="筛选任务项目" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">全部项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}<option value="daily">日常</option></select>
      <select aria-label="筛选任务状态" value={status} onChange={(event) => setStatus(event.target.value)}>{[['unfinished', '未完成'], ['all', '全部状态'], ['idle', '未开始'], ['running', '执行中'], ['waiting', '阻塞'], ['paused', '已暂停'], ['exception', '执行异常'], ['done', '已完成']].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
      <div className="task-panel-views" role="group" aria-label="任务视图"><IconButton label="列表视图" aria-pressed={view === 'list'} onClick={() => { endDrag(); setView('list'); }}><List /></IconButton><IconButton label="看板视图" aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns3 /></IconButton></div>
    </header>
    <div className={`task-drag-notice ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice}</div>
    <div className="task-panel-content">
      <div className="task-panel-surface" ref={surface}>
        {view === 'list' ? <div className="task-panel-list" aria-label="任务列表">{sections.map((section) => <section key={section.id} aria-label={section.name}><h2 className="task-panel-group"><Folder />{section.name}</h2>{section.tasks.map((task) => {
          const state = presentTask(task, requests);
          return <div className={`task-compact-row ${selected?.id === task.id ? 'selected' : ''}`} key={task.id}><button className="task-compact-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected?.id === task.id} onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span title={state.summary}>{state.summary}</span></button><span className={`task-panel-status ${state.tone}`}>{state.label}</span><div className="task-row-actions"><TaskActions {...actionsFor(task)} compact /></div></div>;
        })}</section>)}{!visible.length && <div className="task-panel-empty"><Search /><p>没有符合筛选条件的任务</p></div>}</div> : <div className="task-panel-board" aria-label="任务状态看板">{TASK_COLUMNS.map((column) => {
          const items = visible.filter((task) => presentTask(task, requests).column === column.id).sort((a, b) => Number(presentTask(a, requests).abnormal) - Number(presentTask(b, requests).abnormal));
          const exceptions = column.id === 'running' ? items.filter((task) => presentTask(task, requests).abnormal) : [];
          const ColumnIcon = { idle: CircleDashed, running: LoaderCircle, waiting: CircleAlert, paused: Pause, done: CheckCircle2 }[column.id];
          const dropAction = draggedTask ? taskDropAction(draggedTask, requests, column.id) : null;
          const activeDrop = dropMark?.column === column.id;
          return <section key={column.id} className={`task-board-column ${column.id} ${activeDrop ? dropAction?.kind === 'blocked' ? 'drop-blocked' : 'drop-active' : ''}`} aria-label={column.label} onDragOver={(event) => dragOver(event, column.id)} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); performDrop(column.id, placement.current?.beforeId); }}><h2><ColumnIcon />{column.label}<span>{items.length - exceptions.length}</span></h2>{activeDrop && <div className="task-drop-cue">{dropAction?.kind === 'blocked' ? dropAction.label : `松开以${dropAction?.label}`}</div>}{items.map((task) => {
            const state = presentTask(task, requests);
            return <React.Fragment key={task.id}>{exceptions[0]?.id === task.id && <h3 className="task-board-exceptions">执行异常<span>{exceptions.length}</span></h3>}<article data-task-id={task.id} draggable onDragStart={(event) => beginDrag(task, event)} onDragEnd={endDrag} onDragOver={(event) => dragOver(event, column.id, task.id)} className={`task-board-card ${selected?.id === task.id ? 'selected' : ''} ${state.abnormal ? 'abnormal' : ''} ${draggedId === task.id ? 'dragging' : ''} ${activeDrop && dropMark?.beforeId === task.id && draggedId !== task.id && dropAction?.kind !== 'blocked' ? 'drop-before' : ''}`}><button className="task-card-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected?.id === task.id} onClick={() => { if (!drag.current) onSelect(task.id); }}><div className="task-card-meta"><span><Folder />{projectName(task)}</span>{(state.waitLabel || state.abnormal) && <span className={`task-panel-status ${state.tone}`}>{state.waitLabel || state.label}</span>}</div><strong>{task.title}</strong><p title={state.summary}>{state.summary}</p></button><div className="task-card-actions"><span role="button" tabIndex={0} aria-label={`拖动任务：${task.title}`} title="拖动任务" className="icon-button task-drag-handle" onKeyDown={(event) => { if (!drag.current && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); drag.current = task.id; dropped.current = false; keyboardDrag.current = true; setDraggedId(task.id); markDrop(column.id, task.id); } }}><GripVertical /></span><div><TaskActions {...actionsFor(task)} compact /></div></div></article></React.Fragment>;
          })}{!items.length && <p className="task-board-empty">暂无任务</p>}</section>;
        })}</div>}
        {completed.older.length > 0 && !query.trim() && <button className="task-history-toggle inline-link" onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? '收起较早完成的任务' : `查看更早的 ${completed.older.length} 个已完成任务`}<ArrowRight /></button>}
      </div>
      {selected && <aside className="task-inspector" aria-label="任务详情" key={selected.id}>
        <header><h2>{selected.title}</h2><IconButton label="关闭任务详情" onClick={() => onSelect(null)}><X /></IconButton></header>
        <p className="task-goal">{selected.goal || selected.title}</p>
        <section><h3>当前情况</h3><span className={`task-panel-status ${presentTask(selected, requests).tone}`}>{presentTask(selected, requests).label}</span><p>{selected.reason}</p></section>
        <section><h3>下一步</h3><p>{selected.next}</p><div className="task-detail-actions"><TaskActions {...actionsFor(selected)} /></div></section>
        <section><h3>成果</h3>{outputs.filter((item) => item.taskId === selected.id).map((output) => <button className="task-output-link" key={output.id} onClick={() => onOutput(output.id)}><FileText /><span><strong>{output.title}</strong><small>{output.summary}</small></span><ArrowRight /></button>)}{!outputFor(selected) && <p className="task-panel-muted">暂无已生成的成果</p>}</section>
        <section><h3>任务属性</h3><dl className="task-properties"><div><dt>项目</dt><dd>{projectName(selected)}</dd></div><div><dt>优先级</dt><dd><select aria-label="任务优先级" value={selected.priority} onChange={(event) => updateTask(selected.id, { priority: event.target.value }, `优先级已调整为${event.target.value}`)}><option>高</option><option>中</option><option>低</option></select></dd></div></dl><details><summary>范围、目录与执行信息</summary><dl className="task-properties"><div><dt>范围</dt><dd>{selected.scope}</dd></div><div><dt>目录</dt><dd>{directoryOf(selected).path}{selected.worktree && <small>独立 worktree</small>}</dd></div><div><dt>验收</dt><dd>{selected.acceptance ? '完成后需要验收' : '自检通过后完成'}</dd></div><div><dt>执行会话</dt><dd><button className="inline-link" onClick={() => onSession(selected)}>{selected.session}<MessageSquare /></button></dd></div></dl></details></section>
        <section><h3>最近进展</h3><ol className="task-events">{[...(selected.events || [])].reverse().map((event, index) => <li key={`${event.at}:${index}`}><time>{new Date(event.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time><span>{event.title}</span></li>)}</ol>{!selected.events?.length && <p className="task-panel-muted">暂无已发生的进展</p>}</section>
      </aside>}
    </div>
  </div>;
}
