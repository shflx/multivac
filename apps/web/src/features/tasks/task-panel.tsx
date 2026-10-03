import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { Columns3, List, Search, Plus, X, Play, Pause, CircleX, FileText, MessageSquare, ChevronDown, Folder, CircleDashed, LoaderCircle, CircleAlert, CheckCircle2, GripVertical, ArrowRight } from 'lucide-react';
import type { Task, TaskDetail, TaskControl } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { useTasks } from './tasks-provider.js';
import { useTaskRequests } from './task-requests-provider.js';
import { TaskRequestCard } from './task-request-card.js';
import { ArtifactPreview } from './artifact-preview.js';
import { TaskFilter } from './task-filter.js';
import { TaskIconButton } from './task-icon-button.js';
import { NewTaskDialog } from './new-task-dialog.js';
import { TASK_COLUMNS, taskColumn, taskLabel, splitCompleted, matchesTask, taskDropAction, reorderTasks, type TaskColumn } from './task-panel-state.js';

const STATUS_TONES: Partial<Record<TaskColumn, string>> = { running: 'info', waiting: 'warn', review: 'info', done: 'success' };
const STATUS_ICONS = { idle: CircleDashed, running: LoaderCircle, waiting: CircleAlert, review: CheckCircle2, paused: Pause, done: CheckCircle2, cancelled: CircleX };
const abnormalTask = (task: Task) => ['failed', 'recovery'].includes(task.status);
const PRIORITIES = { high: '高', medium: '中', low: '低' };
export function TaskPanel({ active, onOpenSession, onSelectionChange }: { active: boolean; onOpenSession: (id: string) => void; onSelectionChange?: (id: string | null) => void }) {
  const { store, tasks, selected, total, nextOffset, loading, error, openVersion } = useTasks();
  const { requests } = useTaskRequests();
  const { workspaces, ensureLoaded } = useWorkspaces();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [status, setStatus] = useState('all');
  const [mode, setMode] = useState<'board' | 'list'>('board');
  const [history, setHistory] = useState(false);
  const [seenOpen, setSeenOpen] = useState(0);
  const opening = seenOpen !== openVersion;
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem('multivac.tasks.order.v1') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 10000) : []; } catch { return []; }
  });
  const [dragging, setDragging] = useState<Task | null>(null);
  const [target, setTarget] = useState<TaskColumn | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || !openVersion || !selected) return;
    const main = boardRef.current?.parentElement;
    if (!main) return;
    const reveal = () => {
      const card = boardRef.current?.querySelector(`[data-task-id="${selected}"]`);
      if (!card) return;
      const bounds = main.getBoundingClientRect();
      const target = card.getBoundingClientRect();
      main.scrollLeft += target.left < bounds.left ? target.left - bounds.left : Math.max(0, target.right - bounds.right);
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(main);
    const frame = requestAnimationFrame(reveal);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [active, openVersion, selected]);
  useEffect(() => { if (active) { store?.ensure(); void ensureLoaded().catch(() => undefined); } }, [active, store, ensureLoaded]);
  const rank = new Map(order.map((id, index) => [id, index]));
  const matching = tasks.filter((task) => matchesTask(task, opening ? '' : query, opening ? 'all' : project, opening ? 'all' : status, requests)).sort((a, b) => (rank.get(a.taskId) ?? Infinity) - (rank.get(b.taskId) ?? Infinity));
  const completed = splitCompleted(matching);
  const visible = !opening && !history && !query.trim() ? matching.filter((task) => !completed.older.includes(task)) : matching;
  useEffect(() => { if (!openVersion) return; setQuery(''); setProject('all'); setStatus('all'); setHistory(true); setOutput(null); setSeenOpen(openVersion); }, [openVersion]);
  const visibleSelected = selected && visible.some((task) => task.taskId === selected) ? selected : null;
  useEffect(() => { if (selected && !visibleSelected) store?.select(null); }, [selected, visibleSelected, store]);
  const chosen = tasks.find((task) => task.taskId === visibleSelected);
  // 原型常驻六列；存在暂停任务或移动执行中任务时补充暂停列。
  const boardColumns = TASK_COLUMNS.filter((column) => column.id !== 'paused' || dragging?.status === 'running' || visible.some((task) => taskColumn(task, requests) === 'paused'));
  const summary = (task: Task) => ['waiting', 'review', 'paused', 'cancelled'].includes(taskColumn(task, requests)) ? task.reason : task.nextStep;
  useEffect(() => { setOutput(null); }, [visibleSelected]);
  useEffect(() => { onSelectionChange?.(selected); }, [selected, onSelectionChange]);
  useEffect(() => {
    let current = true;
    setDetail(null);
    if (!visibleSelected || !store) return;
    void store.detail(visibleSelected).then((value) => { if (current) setDetail(value); }).catch((failure) => { if (current) setNotice(failure instanceof Error ? failure.message : '详情未读取。'); });
    return () => { current = false; };
  }, [visibleSelected, chosen?.revision, store]);
  if (!store) return null;
  const projectName = (task: Task) => workspaces?.find((workspace) => workspace.project?.projectId === task.projectId)?.name ?? (task.projectId ? '项目已失效' : '日常');
  async function act(task: Task, action: TaskControl['action']) {
    if (busy) return;
    setBusy(task.taskId); setNotice('');
    try { await store!.control(task, action); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '操作未执行。'); }
    finally { setBusy(null); }
  }
  function endDrag() { setDragging(null); setTarget(null); returnFocus.current?.focus(); }
  async function drop(column: TaskColumn, before?: string) {
    if (!dragging) return;
    const action = taskDropAction(dragging, requests, column);
    if (action.kind === 'reorder') {
      const next = reorderTasks(order, tasks.map((task) => task.taskId), dragging.taskId, before);
      setOrder(next); try { localStorage.setItem('multivac.tasks.order.v1', JSON.stringify(next)); } catch { /* 呈现排序仍在当前窗口有效。 */ }
    } else if (action.kind === 'request') store!.select(dragging.taskId);
    else if (action.kind === 'blocked') setNotice(action.label);
    else await act(dragging, action.kind);
    endDrag();
  }
  function dragOver(event: React.DragEvent, column: TaskColumn) {
    if (!dragging) return;
    event.preventDefault(); event.stopPropagation(); setTarget(column);
    const bounds = boardRef.current?.parentElement?.getBoundingClientRect();
    if (bounds && boardRef.current) {
      if (event.clientX < bounds.left + 48) boardRef.current.parentElement?.scrollBy({ left: -24 });
      if (event.clientX > bounds.right - 48) boardRef.current.parentElement?.scrollBy({ left: 24 });
    }
  }
  function selectTask(task: Task) { setOutput(null); store!.select(task.taskId); }
  const actions = (task: Task, compact = false) => {
    const pending = requests.find((request) => request.taskId === task.taskId && request.status === 'pending');
    const button = (label: string, Icon: typeof Play, onClick: () => void, danger = false) => compact ? <TaskIconButton label={label} aria-label={`${label}：${task.title}`} disabled={busy === task.taskId} onClick={onClick}><Icon /></TaskIconButton> : <button type="button" className={`inline-link ${danger ? 'task-cancel-action' : ''}`} title={label} aria-label={`${label}：${task.title}`} disabled={busy === task.taskId} onClick={onClick}><Icon />{label}</button>;
    return <div className={`task-actions ${compact ? 'compact' : 'task-detail-actions'}`}>
      {compact && pending ? button(pending.kind === 'review' ? '查看成果并验收' : '处理请求', pending.kind === 'review' ? CheckCircle2 : CircleAlert, () => selectTask(task)) : compact && abnormalTask(task) ? <>
        {button('查看原因', CircleAlert, () => selectTask(task))}
        {task.sessionId && button('打开任务会话', MessageSquare, () => onOpenSession(task.sessionId!))}
      </> : <>
        {['idle', 'failed'].includes(task.status) && button('启动任务', Play, () => void act(task, 'start'))}
        {task.status === 'paused' && button('继续任务', Play, () => void act(task, 'resume'))}
        {['queued', 'running', 'waiting'].includes(task.status) && button('暂停任务', Pause, () => void act(task, 'pause'))}
        {compact && ['done', 'cancelled', 'review'].includes(task.status) && button('查看成果', FileText, () => selectTask(task))}
      </>}
      {!compact && <>
        {!['done', 'cancelled'].includes(task.status) && button('取消任务', CircleX, () => void act(task, 'cancel'), true)}
        {task.sessionId && button('打开任务会话', MessageSquare, () => onOpenSession(task.sessionId!))}
      </>}
    </div>;
  };
  const card = (task: Task) => <article key={task.taskId} className={`task-board-card ${selected === task.taskId ? 'selected' : ''} ${dragging?.taskId === task.taskId ? 'dragging' : ''} ${abnormalTask(task) ? 'abnormal' : ''}`} data-task-id={task.taskId} draggable onDragStart={(event) => { returnFocus.current = event.currentTarget; setDragging(task); setTarget(taskColumn(task, requests)); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.taskId); }} onDragEnd={endDrag} onDragOver={(event) => dragOver(event, taskColumn(task, requests))} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void drop(taskColumn(task, requests), task.taskId); }} onKeyDown={(event) => {
    if (!dragging && event.key === ' ' && event.target === event.currentTarget) { event.preventDefault(); returnFocus.current = event.currentTarget; setDragging(task); setTarget(taskColumn(task, requests)); }
    else if (dragging && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const index = boardColumns.findIndex((item) => item.id === target); const column = boardColumns[(index + (event.key === 'ArrowRight' ? 1 : -1) + boardColumns.length) % boardColumns.length]!; setTarget(column.id); boardRef.current?.querySelector(`[data-column="${column.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else if (dragging && event.key === 'Enter' && target) { event.preventDefault(); void drop(target); }
    else if (dragging && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endDrag(); }
    else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const members = visible.filter((item) => taskColumn(item, requests) === taskColumn(task, requests)); const index = members.findIndex((item) => item.taskId === task.taskId); const before = event.key === 'ArrowUp' ? members[index - 1]?.taskId : members[index + 2]?.taskId; const next = reorderTasks(order, tasks.map((item) => item.taskId), task.taskId, before); setOrder(next); localStorage.setItem('multivac.tasks.order.v1', JSON.stringify(next)); }
  }} tabIndex={0} aria-label={`移动任务：${task.title}`}>
    <button type="button" className="task-card-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected === task.taskId} onClick={() => { setOutput(null); store.select(task.taskId); }}>
      <span className="task-card-meta"><span><Folder />{projectName(task)}</span>{!['idle', 'running', 'done', 'cancelled'].includes(taskColumn(task, requests)) && <span className={`task-status ${taskColumn(task, requests)} ${abnormalTask(task) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>}</span>
      <strong title={task.title}>{task.title}</strong><p title={summary(task)}>{summary(task)}</p>
    </button><div className="task-card-actions"><span className="icon-button task-drag-handle" aria-hidden="true" title="拖动任务；聚焦卡片后按空格移动"><GripVertical /></span>{actions(task, true)}</div>
  </article>;
  return <div className={`task-panel ${mode === 'board' ? 'board-mode' : ''} ${dragging ? 'is-dragging' : ''}`}>
    <ManagementPageActions>
      <div className="task-panel-toolbar">
        <label className="task-panel-search"><Search /><input aria-label="搜索任务" placeholder="搜索任务" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="task-panel-filters" role="group" aria-label="任务筛选">
          <TaskFilter label="项目" name="任务项目筛选" icon={Folder} value={project} onChange={setProject} options={[{ id: 'all', label: '全部项目' }, ...(workspaces?.filter((workspace) => workspace.project).map((workspace, index) => ({ id: workspace.project!.projectId, label: workspace.name, divider: index === 0 })) ?? []), { id: 'daily', label: '日常' }]} />
          <TaskFilter label="状态" name="任务状态筛选" icon={CircleDashed} value={status} onChange={setStatus} options={[{ id: 'all', label: '全部状态' }, { id: 'unfinished', label: '未完成' }, ...TASK_COLUMNS.map((column, index) => ({ ...column, icon: STATUS_ICONS[column.id], divider: index === 0, tone: STATUS_TONES[column.id] ?? '' }))]} />
        </div>
        <div className="task-panel-tools">
          <div className="task-view-modes" role="group" aria-label="任务视图"><button type="button" aria-label="任务看板" aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Columns3 />看板</button><button type="button" aria-label="任务列表" aria-pressed={mode === 'list'} onClick={() => { endDrag(); setMode('list'); }}><List />列表</button></div>
          <button type="button" className="primary" onClick={() => setCreating(true)}><Plus />新建任务</button>
        </div>
      </div>
    </ManagementPageActions>
    {(notice || error) && <p className="task-panel-error" role="alert">{notice || error}</p>}
    <div className={`task-panel-layout ${chosen ? 'inspecting' : ''}`}>
      <div className="task-panel-main">
        {loading && !tasks.length && <p className="task-empty">正在读取任务…</p>}
        {mode === 'board' ? <div ref={boardRef} className="task-panel-board" style={{ '--task-column-count': boardColumns.length } as CSSProperties} aria-label="任务状态看板">
          {boardColumns.map((column) => {
            const items = visible.filter((task) => taskColumn(task, requests) === column.id);
            const ColumnIcon = STATUS_ICONS[column.id];
            const dropAction = dragging ? taskDropAction(dragging, requests, column.id) : null;
            const dropClass = target === column.id ? dropAction?.kind === 'blocked' ? 'drop-blocked' : 'drop-target' : '';
            return <section className={`task-board-column ${column.id} ${dropClass}`} key={column.id} aria-label={column.label} data-column={column.id} onDragOver={(event) => dragOver(event, column.id)} onDrop={(event) => { event.preventDefault(); void drop(column.id); }}>
              <h2><ColumnIcon />{column.label}<span>{items.length}</span></h2>
              {dragging && target === column.id && <p className="task-drop-cue" role="status">{dropAction?.label}</p>}
              {items.map(card)}
              {!items.length && <p className="task-empty">暂无任务</p>}
            </section>;
          })}
        </div> : <div className="task-panel-list">
          {[...new Set(visible.map(projectName))].map((name) => <section key={name}>
            <h2><Folder />{name}</h2>
            {visible.filter((task) => projectName(task) === name).map((task) => <div className={`task-list-row ${selected === task.taskId ? 'selected' : ''}`} key={task.taskId}>
              <button type="button" aria-label={`查看任务：${task.title}`} aria-pressed={selected === task.taskId} onClick={() => selectTask(task)}><strong>{task.title}</strong><span title={summary(task)}>{summary(task)}</span></button>
              <span className={`task-status ${taskColumn(task, requests)} ${abnormalTask(task) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>
              {actions(task, true)}
            </div>)}
          </section>)}
        </div>}
        {!loading && !visible.length && <p className="task-empty"><Search />没有符合筛选条件的任务</p>}
        {!query.trim() && completed.older.length > 0 && <button type="button" className="inline-link task-history" onClick={() => setHistory(!history)}><ChevronDown />{history ? '收起较早完成任务' : `查看更早的 ${completed.older.length} 个完成任务`}</button>}
        <p className="task-total" aria-label="任务数量">当前显示 {visible.length} / {total} 个任务</p>
        {nextOffset !== null && <button type="button" className="secondary" disabled={loading} onClick={() => void store.refresh(true)}>{loading ? '读取中…' : '加载更多任务'}</button>}
      </div>
      {chosen && <aside className="task-inspector" aria-label="任务详情"><header><h2>{chosen.title}</h2><TaskIconButton label="关闭任务详情" onClick={() => store.select(null)}><X /></TaskIconButton></header><p className="task-goal">{chosen.goal}</p>
        <section><h3>当前情况</h3><span className={`task-status ${taskColumn(chosen, requests)} ${abnormalTask(chosen) ? 'danger' : ''}`}>{taskLabel(chosen, requests)}</span><p>{chosen.reason}</p></section>
        <section><h3>下一步</h3><p>{chosen.nextStep}</p>{actions(chosen)}</section>
        <section><h3>成果</h3>{detail?.artifacts?.length ? detail.artifacts.map((version) => <button type="button" className="task-output-link" key={version.versionId} onClick={() => setOutput(output === version.versionId ? null : version.versionId)}><FileText /><span><strong>{version.title}</strong><small>版本 {version.version} · {version.status === 'accepted' ? '已验收' : version.status === 'changes' ? '待修改' : '待核对'}</small></span><ArrowRight /></button>) : <p className="task-muted">暂无成果</p>}{output && <ArtifactPreview versionId={output} />}</section>
        {requests.filter((request) => request.taskId === chosen.taskId && request.status === 'pending' && request.kind !== 'authorization').map((request) => <TaskRequestCard key={request.requestId} request={request} />)}
        <section><h3>任务属性</h3><dl className="task-properties"><div><dt>项目</dt><dd>{projectName(chosen)}</dd></div><div><dt>优先级</dt><dd><select aria-label="任务优先级" value={chosen.priority} disabled={['done', 'cancelled'].includes(chosen.status)} onChange={(event) => void store.update(chosen, { priority: event.target.value as Task['priority'] }).catch((failure) => setNotice(failure.message))}>{Object.entries(PRIORITIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></dd></div></dl><details><summary>范围、目录与执行信息</summary><dl className="task-properties"><div><dt>范围</dt><dd>{chosen.scope || '本任务独立目录'}</dd></div><div><dt>目录</dt><dd>{detail?.runs?.[0]?.directory?.path ?? '尚未准备'}</dd></div><div><dt>验收</dt><dd>{chosen.acceptance ? '需要人工验收' : chosen.acceptanceCriteria || '待明确自检要求'}</dd></div><div><dt>依赖</dt><dd>{chosen.dependencyIds.map((id) => tasks.find((task) => task.taskId === id)?.title ?? id).join('、') || '无'}</dd></div><div><dt>运行</dt><dd>{detail?.runs?.[0]?.reason ?? '暂无执行记录'}</dd></div></dl></details></section>
        <section><h3>最近进展</h3><ol className="task-events">{detail?.events.map((event) => <li key={event.eventId}><time>{new Date(event.occurredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>{event.summary}</span></li>)}</ol>{detail?.nextEventBefore && <button type="button" className="inline-link" onClick={() => void store.detail(chosen.taskId, detail.nextEventBefore!).then((value) => setDetail({ ...detail, events: [...detail.events, ...value.events], nextEventBefore: value.nextEventBefore }))}>更早进展</button>}</section>
      </aside>}
    </div>
    {creating && <NewTaskDialog initialProjectId={project} projects={workspaces?.filter((workspace) => workspace.project).map((workspace) => ({ id: workspace.project!.projectId, name: workspace.name })) ?? []} onClose={() => setCreating(false)} onCreated={(task) => { setCreating(false); setQuery(''); setProject('all'); setStatus('all'); store.select(task.taskId); }} />}
  </div>;
}
