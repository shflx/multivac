import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronDown, CheckCircle2, CircleAlert, CircleDashed, CircleHelp, CircleX, FileText, Folder, GripVertical, List, LoaderCircle, Columns3, MessageSquare, Pause, Play, Plus, Search, UserRound, X } from 'lucide-react';
import { TASK_COLUMNS, presentTask, filterPanelTasks, splitCompleted, visibleSelectedId, taskDropAction, orderTasks, reorderTasks } from './task-panel-state.js';

import { TaskRelationshipFields } from './task-relationship-fields.jsx';
import { TaskInspector } from './task-inspector.jsx';
import { taskTreeRows } from './task-relations.js';
const STATUS_ICONS = { idle: CircleDashed, running: LoaderCircle, waiting: CircleAlert, review: CheckCircle2, paused: Pause, done: CheckCircle2, cancelled: CircleX };

function TaskFilter({ label, name, icon: Icon, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const optionRefs = useRef([]);
  const search = useRef({ text: '', at: 0 });
  const listId = useId();
  const selected = options.find((option) => option.id === value) || options[0];

  useEffect(() => {
    if (!open) return;
    function dismiss(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus({ preventScroll: true });
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  function show(index = options.findIndex((option) => option.id === value)) {
    search.current = { text: '', at: 0 };
    setActiveIndex(Math.max(0, index));
    setOpen(true);
  }

  function choose(id) {
    onChange(id);
    setOpen(false);
    trigger.current?.focus();
  }

  function navigate(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setActiveIndex((index) => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Tab') {
      // 焦点先回到触发器，浏览器随后按正常顺序移至下一个控件。
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const text = (now - search.current.at < 700 ? search.current.text : '') + event.key.toLowerCase();
      search.current = { text, at: now };
      const index = options.findIndex((option) => option.label.toLowerCase().startsWith(text));
      if (index >= 0) setActiveIndex(index);
    }
  }

  return <div ref={root} className={`task-panel-filter ${value && value !== 'all' ? 'active' : ''} ${open ? 'open' : ''}`}>
    <button ref={trigger} type="button" className="task-filter-trigger" aria-label={`${name}：${selected.label}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={(event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); show(); }
    }}><Icon aria-hidden="true" /><span className="task-filter-label">{label}</span><span className="task-filter-value" title={selected.label}>{selected.label}</span><ChevronDown className="task-filter-chevron" aria-hidden="true" /></button>
    {open && <div id={listId} className="task-filter-menu" role="listbox" aria-label={name} onKeyDown={navigate}>
      <div className="task-filter-menu-heading" role="presentation">选择{label}</div>
      {options.map((option, index) => {
        const OptionIcon = option.icon || Icon;
        return <button type="button" key={option.id} ref={(element) => { optionRefs.current[index] = element; }} role="option" aria-selected={option.id === value} tabIndex={index === activeIndex ? 0 : -1} className={`task-filter-option ${option.id === value ? 'selected' : ''} ${option.divider ? 'divider' : ''}`} onFocus={() => setActiveIndex(index)} onClick={() => choose(option.id)}><OptionIcon className={option.tone || ''} aria-hidden="true" /><span>{option.label}</span>{option.id === value && <Check className="task-filter-check" aria-hidden="true" />}</button>;
      })}
    </div>}
  </div>;
}

function CreateTaskDialog({ projects, tasks, parentTask, projectId, onCreate, onClose, IconButton }) {
  const dialog = useRef(null);
  const titleInput = useRef(null);
  const goalInput = useRef(null);
  const opener = useRef(document.activeElement);
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState({ title: '', goal: '', scope: '', projectId: parentTask ? parentTask.projectId || '' : ['all', 'daily'].includes(projectId) ? '' : projectId, priority: '中', acceptance: true, humanOnly: false, parentTaskId: parentTask?.id || null, dependencyIds: [] });
  const [error, setError] = useState('');
  const submitting = useRef(false);

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    titleInput.current?.focus();
    return () => {
      element.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);

  function update(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    setError('');
  }

  function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (!draft.title.trim()) { setError('请填写任务名称'); titleInput.current?.focus(); return; }
    if (!draft.goal.trim()) { setError('请填写目标说明'); goalInput.current?.focus(); return; }
    submitting.current = true;
    try {
      onCreate(draft);
    } catch (cause) {
      submitting.current = false;
      setError(cause.message || '任务创建失败，请重试');
    }
  }

  return createPortal(<dialog ref={dialog} className="task-create-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={submit}>
      <header><div><h2 id={titleId}>创建任务</h2><p id={descriptionId}>先记录要做的事，创建后可从任务面板查看和处理。</p></div><IconButton type="button" label="关闭创建任务" onClick={onClose}><X /></IconButton></header>
      <div className="task-create-fields">
        <label className="task-create-field"><span>任务名称 <small>必填</small></span><input ref={titleInput} required maxLength={120} value={draft.title} onChange={(event) => update({ title: event.target.value })} placeholder="例如：整理本周项目进展" /></label>
        <label className="task-create-field"><span>目标说明 <small>必填</small></span><textarea ref={goalInput} required rows={3} maxLength={2000} value={draft.goal} onChange={(event) => update({ goal: event.target.value })} placeholder="描述希望得到的结果，以及需要注意的要求" /></label>
        <div className="task-create-options">
          <TaskFilter label="项目" name="任务所属项目" icon={Folder} value={draft.projectId} onChange={(projectId) => { if (!parentTask) update({ projectId, parentTaskId: null, dependencyIds: [] }); }} options={[{ id: '', label: '不关联项目' }, ...projects.map((project, index) => ({ id: project.id, label: project.name, divider: index === 0 }))]} />
          <TaskFilter label="优先级" name="任务优先级" icon={CircleAlert} value={draft.priority} onChange={(priority) => update({ priority })} options={['高', '中', '低'].map((priority) => ({ id: priority, label: priority }))} />
        </div>
        <label className="task-create-field"><span>资料范围 <small>选填</small></span><input maxLength={1000} value={draft.scope} onChange={(event) => update({ scope: event.target.value })} placeholder="例如：当前项目文档、指定参考资料" /></label>
        <details className="task-create-relations" open={!!parentTask || undefined}><summary>任务关系（选填）</summary><TaskRelationshipFields task={{ id: 'new-task', projectId: draft.projectId || null }} tasks={tasks} value={draft} onChange={update} fixedParent={!!parentTask} /></details>
        <label className="task-create-acceptance"><input type="checkbox" checked={draft.humanOnly} onChange={(event) => update({ humanOnly: event.target.checked })} /><span>我来处理</span></label><p className="task-panel-muted">选中后由你完成，Agent 不会执行。</p>
        {!draft.humanOnly && <label className="task-create-acceptance"><input type="checkbox" checked={draft.acceptance} onChange={(event) => update({ acceptance: event.target.checked })} /><span>完成后需要我验收</span></label>}{!draft.humanOnly && !draft.acceptance && <p className="task-panel-muted">无需人工验收时，会检查成果内容非空。</p>}
        {error && <p className="task-create-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="secondary" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={!draft.title.trim() || !draft.goal.trim()}><Plus />创建任务</button></footer>
    </form>
  </dialog>, document.body);
}

function TaskActions({ task, state, onStart, onPause, onRequest, onSession, onOutput, onSelect, onHumanComplete, compact = false, IconButton }) {
  if (task.humanOnly && !['done', 'cancelled'].includes(task.status) && !state.request) return <button type="button" className="inline-link" onClick={() => onHumanComplete(task)}><CheckCircle2 />标记完成</button>;
  if (task.status === 'queued') return <button type="button" className="inline-link" onClick={() => onPause(task)}><Pause />暂停任务</button>;
  if (compact) {
    if (state.request) return <IconButton label={state.waitLabel === '验收' ? '查看成果并验收' : '处理请求'} onClick={() => onRequest(task)}>{state.waitLabel === '验收' ? <CheckCircle2 /> : <CircleHelp />}</IconButton>;
    if (state.abnormal) return <><IconButton label="查看原因" onClick={() => onSelect(task.id)}><CircleAlert /></IconButton><IconButton label="进入现场" onClick={() => onSession(task)}><MessageSquare /></IconButton></>;
    if (state.column === 'running') return <IconButton label="暂停" onClick={() => onPause(task)}><Pause /></IconButton>;
    if (['idle', 'paused'].includes(state.column)) return <IconButton label={state.column === 'paused' ? '继续' : '启动'} onClick={() => onStart(task.id)}><Play /></IconButton>;
    return onOutput ? <IconButton label="查看成果" onClick={onOutput}><FileText /></IconButton> : null;
  }
  if (state.request) return <button className="inline-link" onClick={() => onRequest(task)}>{state.waitLabel === '验收' ? <CheckCircle2 /> : <CircleAlert />}{state.waitLabel === '验收' ? '查看成果并验收' : '处理请求'}</button>;
  if (task.status === 'failed') return <button className="inline-link" onClick={() => onStart(task.id)}><Play />启动任务</button>;
  if (state.abnormal) return <><button className="inline-link" onClick={() => onSelect(task.id)}><CircleAlert />查看原因</button><button className="inline-link" onClick={() => onSession(task)}><MessageSquare />进入现场</button></>;
  if (state.column === 'running') return <button className="inline-link" onClick={() => onPause(task)}><Pause />暂停</button>;
  if (state.column === 'idle' || state.column === 'paused') return <button className="inline-link" onClick={() => onStart(task.id)}><Play />{state.column === 'paused' ? '继续' : '启动'}</button>;
  if (state.column === 'done') return onOutput ? <button className="inline-link" onClick={onOutput}><FileText />查看成果</button> : <span className="task-panel-muted">暂无成果文件</span>;
  if (state.column === 'cancelled') return onOutput ? <button className="inline-link" onClick={onOutput}><FileText />查看保留成果</button> : null;
  return <button className="inline-link" onClick={() => onSession(task)}><MessageSquare />进入现场</button>;
}

export function TaskPanel({ active = true, openVersion = 0, tasks, projects, requests, outputs, selectedId, onSelect, updateTask, onStart, onCreate, onCancel, onDelete, onHumanComplete, onRequest, onSession, onOutput, directoryOf, resolveRequest, drafts, updateDraft, IconButton }) {
  const [seenOpen, setSeenOpen] = useState(0);
  const opening = seenOpen !== openVersion;
  const [view, setView] = useState('board');
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [status, setStatus] = useState('all');
  const [history, setHistory] = useState({ board: false, list: false });
  const historyOpen = history[view];
  const setHistoryOpen = (value) => setHistory((current) => ({ ...current, [view]: value }));
  const [handling, setHandling] = useState('all');
  const [parentTask, setParentTask] = useState(null);
  const [sources, setSources] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState(null);
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
  const filtered = orderTasks(filterPanelTasks(tasks, requests, opening ? { status: 'all' } : { query, project, status: view === 'board' ? 'all' : status, handling }), order);
  const completed = splitCompleted(filtered);
  const visible = filtered.filter((task) => task.status !== 'done' || opening || historyOpen || query.trim() || completed.recent.includes(task));
  useEffect(() => { if (!opening) return; setQuery(''); setProject('all'); setStatus('all'); setHandling('all'); setHistoryOpen(true); setSeenOpen(openVersion); }, [openVersion, opening]);
  const validId = visibleSelectedId(selectedId, [...visible, ...taskTreeRows(visible, tasks, expanded).map((row) => row.task)]);
  const selected = tasks.find((task) => task.id === validId);
  useEffect(() => { if (active && selectedId && !validId) onSelect(null); }, [active, selectedId, validId]);
  const projectName = (task) => projects.find((item) => item.id === task.projectId)?.name || '日常';
  const outputFor = (task) => outputs.find((item) => item.taskId === task.id);
  const pauseTask = (item) => updateTask(item.id, { status: 'paused', resumeNext: item.next, reason: '你已主动暂停，已有工作保留', next: '继续后恢复原步骤' });
  const actionsFor = (task) => ({ task, state: presentTask(task, requests), onStart, onPause: pauseTask, onRequest: (item) => onSelect(item.id), onSession, onSelect, onHumanComplete, IconButton, onOutput: outputFor(task) ? () => onOutput(outputFor(task).id) : null });
  const sections = [...projects.map((item) => ({ id: item.id, name: item.name })), { id: 'daily', name: '日常' }].map((item) => ({ ...item, tasks: visible.filter((task) => (task.projectId || 'daily') === item.id) })).filter((item) => item.tasks.length);
  const draggedTask = tasks.find((task) => task.id === draggedId);

  const BOARD_COLUMNS = TASK_COLUMNS.filter((column) => column.id !== 'paused' || draggedTask?.status === 'running' || visible.some((task) => presentTask(task, requests).column === 'paused'));

  function navigateTask(id, returning = false) {
    setQuery(''); setProject('all'); setStatus('all'); setHandling('all'); setHistoryOpen(true);
    setSources((current) => returning ? current.slice(0, -1) : selectedId ? [...current, selectedId] : current);
    onSelect(id);
  }

  function createTask(draft) {
    const task = onCreate(draft);
    setQuery('');
    setProject(task.projectId || 'daily');
    setStatus('all');
    setHandling('all');
    setOrder((current) => [task.id, ...current.filter((id) => id !== task.id)]);
    onSelect(task.id);
    setCreatedId(task.id);
    setCreating(false);
    setNotice(`已创建「${task.title}」，${task.humanOnly ? '由你处理，完成后可标记完成' : '可点击启动开始执行'}`);
  }

  useEffect(() => {
    if (!createdId) return;
    const element = [...(surface.current?.querySelectorAll('[data-task-id]') || [])].find((item) => item.dataset.taskId === createdId);
    if (view === 'board') element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    else surface.current?.scrollTo({ top: 0 });
    setCreatedId(null);
  }, [createdId, view]);

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
      if (action.kind === 'cancel') onCancel(task.id);
      if (action.kind === 'request') onSelect(task.id);
      setNotice(action.kind === 'request' ? '已打开原请求，处理后更新任务状态' : action.kind === 'cancel' ? '任务已取消，已有记录保留' : action.kind === 'reorder' ? '任务顺序已更新' : action.label === '启动任务' ? '任务已启动' : action.label === '暂停任务' ? '任务已暂停' : '任务已继续');
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
      const index = BOARD_COLUMNS.findIndex((item) => item.id === column);
      markDrop(BOARD_COLUMNS[Math.max(0, Math.min(BOARD_COLUMNS.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))].id);
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
    {creating && <CreateTaskDialog projects={projects} tasks={tasks} parentTask={parentTask} projectId={project} onCreate={createTask} onClose={() => setCreating(false)} IconButton={IconButton} />}
    <header className="task-panel-toolbar"><h1>待办</h1>
      <label className="task-panel-search"><Search /><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="task-panel-filters" role="group" aria-label="任务筛选">
        <TaskFilter label="项目" name="筛选任务项目" icon={Folder} value={project} onChange={setProject} options={[{ id: 'all', label: '全部项目' }, ...projects.map((item, index) => ({ id: item.id, label: item.name, divider: index === 0 })), { id: 'daily', label: '日常' }]} />
        <TaskFilter label="处理方式" name="任务处理方式" icon={UserRound} value={handling} onChange={setHandling} options={[{ id: 'all', label: '全部任务' }, { id: 'human', label: '我来处理' }, { id: 'agent', label: 'Agent 处理' }]} />
        {view === 'list' && <TaskFilter label="状态" name="筛选任务状态" icon={CircleDashed} value={status} onChange={setStatus} options={[{ id: 'all', label: '全部状态' }, { id: 'unfinished', label: '未完成' }, ...TASK_COLUMNS.map((column, index) => ({ ...column, icon: STATUS_ICONS[column.id], divider: index === 0, tone: { running: 'info', waiting: 'warn', review: 'info', done: 'success' }[column.id] }))]} />}
      </div>
      <div className="task-panel-views" role="group" aria-label="任务视图"><button type="button" aria-label="看板视图" aria-pressed={view === 'board'} onClick={() => setView('board')}><Columns3 />看板</button><button type="button" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => { endDrag(); setView('list'); }}><List />列表</button></div>
      <button type="button" className="primary task-panel-create" onClick={() => { endDrag(); setParentTask(null); setCreating(true); }}><Plus />创建任务</button>
    </header>
    <div className={`task-drag-notice ${notice ? 'visible' : ''}`} role="status" aria-live="polite">{notice}</div>
    <div className="task-panel-content">
      <div className="task-panel-surface" ref={surface}>
        {view === 'list' ? <div className="task-panel-list" aria-label="任务列表">{sections.map((section) => <section key={section.id} aria-label={section.name}><h2 className="task-panel-group"><Folder />{section.name}</h2>{taskTreeRows(section.tasks, tasks, expanded).map(({ task, depth, children }) => {
          const state = presentTask(task, requests);
          return <div style={{ paddingLeft: `${depth * 20}px` }} data-task-id={task.id} className={`task-compact-row ${selected?.id === task.id ? 'selected' : ''}`} key={task.id}>{!!children.length && <button type="button" className="icon-button" aria-label={`展开子任务：${task.title}`} aria-expanded={expanded.has(task.id)} onClick={() => setExpanded((current) => { const next = new Set(current); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next; })}><ChevronDown /></button>}<button className="task-compact-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected?.id === task.id} onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span title={state.summary}>{state.summary}</span></button><span className={`task-panel-status ${state.tone}`}>{state.label}</span><div className="task-row-actions"><TaskActions {...actionsFor(task)} compact /></div></div>;
        })}</section>)}{!visible.length && <div className="task-panel-empty"><Search /><p>没有符合筛选条件的任务</p></div>}</div> : <div className="task-panel-board" style={{ gridTemplateColumns: `repeat(${BOARD_COLUMNS.length}, minmax(256px, 1fr))` }} aria-label="任务状态看板">{BOARD_COLUMNS.map((column) => {
          const items = visible.filter((task) => presentTask(task, requests).column === column.id);
          const ColumnIcon = STATUS_ICONS[column.id];
          const dropAction = draggedTask ? taskDropAction(draggedTask, requests, column.id) : null;
          const activeDrop = dropMark?.column === column.id;
          return <section key={column.id} className={`task-board-column ${column.id} ${activeDrop ? dropAction?.kind === 'blocked' ? 'drop-blocked' : 'drop-active' : ''}`} aria-label={column.label} onDragOver={(event) => dragOver(event, column.id)} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); performDrop(column.id, placement.current?.beforeId); }}><h2><ColumnIcon />{column.label}<span>{items.length}</span></h2>{activeDrop && <div className="task-drop-cue">{dropAction?.kind === 'blocked' ? dropAction.label : `松开以${dropAction?.label}`}</div>}{items.map((task) => {
            const state = presentTask(task, requests);
            return <article key={task.id} data-task-id={task.id} draggable onDragStart={(event) => beginDrag(task, event)} onDragEnd={endDrag} onDragOver={(event) => dragOver(event, column.id, task.id)} className={`task-board-card ${selected?.id === task.id ? 'selected' : ''} ${state.abnormal ? 'abnormal' : ''} ${draggedId === task.id ? 'dragging' : ''} ${activeDrop && dropMark?.beforeId === task.id && draggedId !== task.id && dropAction?.kind !== 'blocked' ? 'drop-before' : ''}`}><button className="task-card-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected?.id === task.id} onClick={() => { if (!drag.current) onSelect(task.id); }}><div className="task-card-meta">{task.humanOnly && <span><UserRound />我来处理</span>}<span><Folder />{projectName(task)}</span>{(state.waitLabel || state.abnormal || task.status === 'queued') && <span className={`task-panel-status ${state.tone}`}>{state.waitLabel || state.label}</span>}</div><strong>{task.title}</strong><p title={state.summary}>{state.summary}</p></button><div className="task-card-actions">{tasks.some((item) => item.parentTaskId === task.id) && <small>子任务已完成 {tasks.filter((item) => item.parentTaskId === task.id && item.status === 'done').length} / {tasks.filter((item) => item.parentTaskId === task.id).length}</small>}<span role="button" tabIndex={0} aria-label={`拖动任务：${task.title}`} title="拖动任务" className="icon-button task-drag-handle" onKeyDown={(event) => { if (!drag.current && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); drag.current = task.id; dropped.current = false; keyboardDrag.current = true; setDraggedId(task.id); markDrop(column.id, task.id); } }}><GripVertical /></span><div><TaskActions {...actionsFor(task)} compact /></div></div></article>;
          })}{!items.length && <p className="task-board-empty">暂无任务</p>}</section>;
        })}</div>}
        {completed.older.length > 0 && !query.trim() && <button className="task-history-toggle inline-link" onClick={() => setHistoryOpen(!historyOpen)}>{historyOpen ? '收起较早完成的任务' : `查看更早的 ${completed.older.length} 个已完成任务`}<ArrowRight /></button>}
      </div>
      {selected && <TaskInspector key={selected.id} task={selected} tasks={tasks} projects={projects} requests={requests} outputs={outputs} actions={<TaskActions {...actionsFor(selected)} />} onSelect={onSelect} onNavigate={navigateTask} onBack={sources.length ? () => navigateTask(sources.at(-1), true) : null} onCreateChild={() => { setParentTask(selected); setCreating(true); }} updateTask={updateTask} onCancel={onCancel} onDelete={onDelete} onHumanComplete={onHumanComplete} onSession={onSession} onOutput={onOutput} directoryOf={directoryOf} resolveRequest={resolveRequest} drafts={drafts} updateDraft={updateDraft} IconButton={IconButton} />}
    </div>
  </div>;
}
