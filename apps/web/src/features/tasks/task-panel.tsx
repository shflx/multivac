import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { UserRound, Columns3, List, Search, Plus, X, Play, Pause, CircleX, MessageSquare, Trash2, ChevronDown, Folder, CircleDashed, LoaderCircle, CircleAlert, CheckCircle2, GripVertical, ArrowRight } from 'lucide-react';
import type { Task, TaskDetail, TaskControl, TaskViewStatus } from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { useTasks } from './tasks-provider.js';
import { useTaskRequests } from './task-requests-provider.js';
import { TaskInspectorContent } from './task-inspector.js';
import { TaskFilter } from './task-filter.js';
import { TaskIconButton } from './task-icon-button.js';
import { TaskRelations } from './task-relations.js';
import { TaskTreeList } from './task-tree-list.js';
import { NewTaskDialog } from './new-task-dialog.js';
import { TASK_COLUMNS, taskColumn, taskLabel, splitCompleted, matchesTask, taskDropAction, reorderTasks, type TaskColumn } from './task-panel-state.js';

const STATUS_TONES: Partial<Record<TaskColumn, string>> = { running: 'info', waiting: 'warn', review: 'info', done: 'success' };
const STATUS_ICONS = { idle: CircleDashed, running: LoaderCircle, waiting: CircleAlert, review: CheckCircle2, paused: Pause, done: CheckCircle2, cancelled: CircleX };
const abnormalTask = (task: Task) => ['failed', 'recovery'].includes(task.status);
export function TaskPanel({ active, onOpenSession, onSelectionChange }: { active: boolean; onOpenSession: (id: string) => void; onSelectionChange?: (id: string | null) => void }) {
  const { store, tasks: cachedTasks, panelIds, selected, total, nextOffset, loading, error, openVersion, relations } = useTasks();
  const { requests, error: requestError, store: requestStore } = useTaskRequests();
  const taskById = new Map(cachedTasks.map((task) => [task.taskId, task]));
  const tasks = panelIds.flatMap((id) => { const task = taskById.get(id); return task ? [task] : []; });
  const confirm = useConfirm();
  const panelRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const { workspaces, ensureLoaded } = useWorkspaces();
  const [query, setQuery] = useState('');
  const [handling, setHandling] = useState('all');
  const [project, setProject] = useState('all');
  const [listStatus, setListStatus] = useState('all');
  const [mode, setMode] = useState<'board' | 'list'>('board');
  const status = mode === 'list' ? listStatus : 'all';
  const [historyByMode, setHistoryByMode] = useState({ board: false, list: false });
  const history = historyByMode[mode];
  const setHistory = (value: boolean) => setHistoryByMode((previous) => ({ ...previous, [mode]: value }));
  const [seenOpen, setSeenOpen] = useState(0);
  const opening = seenOpen !== openVersion;
  const [creating, setCreating] = useState(false);
  const [creatingParent, setCreatingParent] = useState<Task | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const navigation = useRef(0);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [notice, setNotice] = useState('');
  const [detailError, setDetailError] = useState('');
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [progressLoading, setProgressLoading] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem('multivac.tasks.order.v1') ?? '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id)).slice(0, 10000) : []; } catch { return []; }
  });
  const [dragging, setDragging] = useState<Task | null>(null);
  const [target, setTarget] = useState<TaskColumn | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || !selected) return;
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
  useEffect(() => {
    if (!active || !store) return;
    store.setFilter(opening ? {} : {
      ...(handling !== 'all' ? { humanOnly: handling === 'human' } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(project !== 'all' ? { projectId: project } : {}),
      ...(status !== 'all' ? { viewStatus: status as TaskViewStatus } : {}),
    });
  }, [active, store, query, project, status, handling, opening]);
  const rank = new Map(order.map((id, index) => [id, index]));
  const matching = tasks.filter((task) => (opening || handling === 'all' || !!task.humanOnly === (handling === 'human')) && matchesTask(task, opening ? '' : query, opening ? 'all' : project, opening ? 'all' : status, requests)).sort((a, b) => (rank.get(a.taskId) ?? Infinity) - (rank.get(b.taskId) ?? Infinity));
  const completed = splitCompleted(matching);
  const visible = !opening && !history && !query.trim() ? matching.filter((task) => !completed.older.includes(task)) : matching;
  useEffect(() => { if (!openVersion) return; setQuery(''); setProject('all'); setHandling('all'); if (mode === 'list') setListStatus('all'); setHistory(true); setSeenOpen(openVersion); }, [openVersion]);
  const visibleSelected = selected && visible.some((task) => task.taskId === selected) ? selected : null;
  useEffect(() => { if (selected && !visibleSelected) store?.select(null); }, [selected, visibleSelected, store]);
  const chosen = tasks.find((task) => task.taskId === visibleSelected);
  // 原型常驻六列；存在暂停任务或移动执行中任务时补充暂停列。
  const boardColumns = TASK_COLUMNS.filter((column) => column.id !== 'paused' || dragging?.status === 'running' || visible.some((task) => taskColumn(task, requests) === 'paused'));
  const summary = (task: Task) => {
    const pending = requests.find((request) => request.taskId === task.taskId && request.status === 'pending');
    if (pending) return pending.kind === 'review' ? '成果待验收' : pending.kind === 'authorization' ? '等待你的授权' : pending.question;
    if (['failed', 'recovery', 'paused', 'cancelled'].includes(task.status)) return task.reason;
    const dependencies = relations[task.taskId]?.dependencies;
    if (task.status === 'queued' && dependencies && dependencies.done < dependencies.total) {
      const count = dependencies.total - dependencies.done;
      return `等待「${dependencies.firstUnmet?.title ?? '前置任务'}」进入审核中或已完成${count > 1 ? `，另有 ${count - 1} 项` : ''}`;
    }
    return task.status === 'idle' ? (task.goal.trim() === task.title.trim() ? '' : task.goal) : task.reason;
  };
  useEffect(() => { onSelectionChange?.(selected); }, [selected, onSelectionChange]);
  useEffect(() => {
    let current = true;
    setDetail(null); setDetailError('');
    if (!visibleSelected || !store) return;
    void store.detail(visibleSelected).then((value) => { if (current) setDetail(value); }).catch((failure) => { if (current) setDetailError(failure instanceof Error ? failure.message : '详情未读取。'); });
    return () => { current = false; };
  }, [visibleSelected, chosen?.revision, store, detailAttempt]);
  if (!store) return null;
  const projectName = (task: Task) => workspaces?.find((workspace) => workspace.project?.projectId === task.projectId)?.name ?? (task.projectId ? '项目已失效' : '日常');
  async function act(task: Task, action: TaskControl['action']) {
    if (busy) return;
    setBusy(task.taskId); setNotice('');
    try { await store!.control(task, action); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '操作未执行。'); }
    finally { setBusy(null); }
  }
  async function earlierProgress() {
    const taskId = chosen?.taskId;
    const before = detail?.nextEventBefore;
    if (!store || !taskId || !before || progressLoading === taskId) return;
    setProgressLoading(taskId); setDetailError('');
    try {
      const page = await store.detail(taskId, before);
      setDetail((current) => current?.task.taskId === taskId && current.nextEventBefore === before
        ? { ...current, events: [...current.events, ...page.events], nextEventBefore: page.nextEventBefore } : current);
    } catch (failure) {
      if (store.snapshot().selected === taskId) setDetailError(failure instanceof Error ? failure.message : '进展未读取。');
    } finally { setProgressLoading((current) => current === taskId ? null : current); }
  }
  async function removeTask(task: Task) {
    const commandId = crypto.randomUUID();
    await confirm({
      title: `删除「${task.title}」`, tone: 'danger', icon: Trash2,
      description: '任务将从待办中移除，会话与成果保留。', confirmLabel: '删除任务',
      fallbackFocus: () => panelRef.current,
      action: async () => {
        await store!.remove(task, commandId);
        setOrder((current) => {
          const next = current.filter((id) => id !== task.taskId);
          try { localStorage.setItem('multivac.tasks.order.v1', JSON.stringify(next)); } catch { /* 当前窗口排序仍有效。 */ }
          return next;
        });
      },
    });
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
  function selectTask(task: Task) {
    ++navigation.current;
    setSources([]);
    setNotice('');
    store!.select(task.taskId);
  }
  function openListTask(id: string) {
    // 当前查询内的行与看板同样直接选中，不先请求详情或重置筛选。
    // 展开出来的筛选外子任务仍走显式导航，保证它能进入可见集合。
    const task = visible.find((item) => item.taskId === id);
    if (task) selectTask(task);
    else void navigateTask(id);
  }
  async function navigateTask(id: string, returning = false) {
    const read = ++navigation.current;
    const source = chosen?.taskId;
    setNotice('');
    try {
      await store!.open(id);
      if (read !== navigation.current || store!.snapshot().selected !== id) return;
      requestAnimationFrame(() => { if (read === navigation.current && store!.snapshot().selected === id) inspectorRef.current?.focus({ preventScroll: true }); });
      setSources((current) => returning ? current.slice(0, -1) : source && source !== id ? [...current, source] : current);
    } catch (failure) { if (read === navigation.current) setNotice(failure instanceof Error ? failure.message : '关联任务未打开。'); }
  }
  async function updateHumanOnly(task: Task, humanOnly: boolean) {
    if (busy) return;
    setBusy(task.taskId); setNotice('');
    try { await store!.update(task, { humanOnly }); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '标记保存失败，请重试。'); }
    finally { setBusy(null); }
  }
  async function confirmHumanCompletion(task: Task) {
    if (busy) return;
    setBusy(task.taskId); setNotice('');
    try { await store!.confirmHumanCompletion(task); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '完成确认失败，请刷新后重试。'); }
    finally { setBusy(null); }
  }
  const actions = (task: Task, compact = false) => {
    const pending = requests.find((request) => request.taskId === task.taskId && request.status === 'pending');
    const canResume = task.status === 'paused' || (task.status === 'waiting' && detail?.task.taskId === task.taskId && detail.runs?.[0]?.stopConfirmed);
    const button = (label: string, Icon: typeof Play, onClick: () => void) => <button type="button" className={compact ? 'inline-link task-card-primary' : 'primary-button'} aria-label={`${label}：${task.title}`} disabled={busy === task.taskId} onClick={onClick}><Icon />{label}</button>;
    return <div className={`task-actions ${compact ? 'compact' : 'task-detail-actions'}`}>
      {compact && pending ? button(pending.kind === 'review' ? '查看成果并验收' : '处理请求', pending.kind === 'review' ? CheckCircle2 : CircleAlert, () => selectTask(task))
        : compact && abnormalTask(task) ? button('查看原因', CircleAlert, () => selectTask(task))
        : !compact && pending ? (pending.kind === 'authorization' && task.sessionId ? button('处理授权', CircleAlert, () => onOpenSession(task.sessionId!)) : null)
        : task.humanOnly && !['done', 'cancelled'].includes(task.status) ? button('标记完成', CheckCircle2, () => void confirmHumanCompletion(task))
        : ['idle', 'failed'].includes(task.status) ? button('启动任务', Play, () => void act(task, 'start'))
        : canResume ? button('继续任务', Play, () => void act(task, 'resume'))
        : ['queued', 'running', 'waiting'].includes(task.status) ? button('暂停任务', Pause, () => void act(task, 'pause'))
        : compact ? button('查看详情', ArrowRight, () => selectTask(task)) : null}
      {!compact && canResume && !task.humanOnly && !pending && <small className="task-resume-hint">继续任务会按当前偏好补充执行额度，已有工作和历史记录保留。{task.parentTaskId && '父子任务共享补充后的额度。'}</small>}
      {!compact && task.sessionId && <button type="button" className="inline-link" aria-label={`打开任务会话：${task.title}`} onClick={() => onOpenSession(task.sessionId!)}><MessageSquare />打开任务会话</button>}
    </div>;
  };
  const management = (task: Task) => <>
    {['queued', 'running', 'waiting'].includes(task.status) && <button type="button" disabled={busy === task.taskId} onClick={() => void act(task, 'pause')}><Pause />暂停任务</button>}
    {!['done', 'cancelled'].includes(task.status) && <button type="button" className="task-cancel-action" aria-label={`取消任务：${task.title}`} disabled={busy === task.taskId} onClick={() => void act(task, 'cancel')}><CircleX />取消任务</button>}
    <button type="button" className="task-cancel-action" title={['idle', 'paused', 'failed', 'done', 'cancelled'].includes(task.status) ? '删除任务' : '请先取消任务并等待执行停止'} aria-label={`删除任务：${task.title}`} disabled={busy === task.taskId || !['idle', 'paused', 'failed', 'done', 'cancelled'].includes(task.status)} onClick={() => void removeTask(task)}><Trash2 />删除任务</button>
  </>;
  const card = (task: Task) => <article key={task.taskId} className={`task-board-card ${selected === task.taskId ? 'selected' : ''} ${dragging?.taskId === task.taskId ? 'dragging' : ''} ${abnormalTask(task) ? 'abnormal' : ''}`} data-task-id={task.taskId} draggable onDragStart={(event) => { returnFocus.current = event.currentTarget; setDragging(task); setTarget(taskColumn(task, requests)); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.taskId); }} onDragEnd={endDrag} onDragOver={(event) => dragOver(event, taskColumn(task, requests))} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void drop(taskColumn(task, requests), task.taskId); }} onKeyDown={(event) => {
    if (!dragging && event.key === ' ' && event.target === event.currentTarget) { event.preventDefault(); returnFocus.current = event.currentTarget; setDragging(task); setTarget(taskColumn(task, requests)); }
    else if (dragging && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const index = boardColumns.findIndex((item) => item.id === target); const column = boardColumns[(index + (event.key === 'ArrowRight' ? 1 : -1) + boardColumns.length) % boardColumns.length]!; setTarget(column.id); boardRef.current?.querySelector(`[data-column="${column.id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else if (dragging && event.key === 'Enter' && target) { event.preventDefault(); void drop(target); }
    else if (dragging && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endDrag(); }
    else if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const members = visible.filter((item) => taskColumn(item, requests) === taskColumn(task, requests)); const index = members.findIndex((item) => item.taskId === task.taskId); const before = event.key === 'ArrowUp' ? members[index - 1]?.taskId : members[index + 2]?.taskId; const next = reorderTasks(order, tasks.map((item) => item.taskId), task.taskId, before); setOrder(next); localStorage.setItem('multivac.tasks.order.v1', JSON.stringify(next)); }
  }} tabIndex={0} aria-label={`移动任务：${task.title}`}>
    <button type="button" className="task-card-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected === task.taskId} onClick={() => selectTask(task)}>
      <span className="task-card-meta">{task.humanOnly && <span><UserRound />我来处理</span>}{(opening || project === 'all') && <span><Folder />{projectName(task)}</span>}{!['idle', 'running', 'done', 'cancelled'].includes(taskColumn(task, requests)) && <span className={`task-status ${taskColumn(task, requests)} ${abnormalTask(task) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>}</span>
      <strong title={task.title}>{task.title}</strong>{summary(task) && <p title={summary(task)}>{summary(task)}</p>}
    </button><div className="task-card-actions"><span className="icon-button task-drag-handle" aria-hidden="true" title="拖动任务；聚焦卡片后按空格移动"><GripVertical /></span>{!!relations[task.taskId]?.children.total && <small>子任务已完成 {relations[task.taskId]!.children.done} / {relations[task.taskId]!.children.total}{relations[task.taskId]!.children.cancelled > 0 && ` · 已取消 ${relations[task.taskId]!.children.cancelled}`}</small>}{actions(task, true)}</div>
  </article>;
  return <div ref={panelRef} tabIndex={-1} className={`task-panel ${mode === 'board' ? 'board-mode' : ''} ${dragging ? 'is-dragging' : ''}`}>
    <ManagementPageActions>
      <div className="task-panel-toolbar">
        <label className="task-panel-search"><Search /><input aria-label="搜索任务" placeholder="搜索任务" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="task-panel-filters" role="group" aria-label="任务筛选">
          <TaskFilter label="项目" name="任务项目筛选" icon={Folder} value={project} onChange={setProject} options={[{ id: 'all', label: '全部项目' }, ...(workspaces?.filter((workspace) => workspace.project).map((workspace, index) => ({ id: workspace.project!.projectId, label: workspace.name, divider: index === 0 })) ?? []), { id: 'daily', label: '日常' }]} />
          <TaskFilter label="处理方式" name="任务处理方式" icon={UserRound} value={handling} onChange={setHandling} options={[{ id: 'all', label: '全部任务' }, { id: 'human', label: '我来处理' }, { id: 'agent', label: 'Agent 处理' }]} />
          {mode === 'list' && <TaskFilter label="状态" name="任务状态筛选" icon={CircleDashed} value={listStatus} onChange={setListStatus} options={[{ id: 'all', label: '全部状态' }, { id: 'unfinished', label: '未完成' }, ...TASK_COLUMNS.map((column, index) => ({ ...column, icon: STATUS_ICONS[column.id], divider: index === 0, tone: STATUS_TONES[column.id] ?? '' }))]} />}
        </div>
        <div className="task-panel-tools">
          <div className="task-view-modes" role="group" aria-label="任务视图"><button type="button" aria-label="任务看板" aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Columns3 />看板</button><button type="button" aria-label="任务列表" aria-pressed={mode === 'list'} onClick={() => { endDrag(); setMode('list'); }}><List />列表</button></div>
          <button type="button" className="primary" onClick={() => { setCreatingParent(null); setCreating(true); }}><Plus />新建任务</button>
        </div>
      </div>
    </ManagementPageActions>
    {(notice || error || requestError) && <div className="task-panel-error" role="alert">
      <span>{notice || error || requestError}</span>
      {error && <button type="button" className="inline-link" disabled={loading} onClick={() => void store.refresh(false, true)}>重试读取任务</button>}
      {requestError && <button type="button" className="inline-link" onClick={() => void requestStore?.refresh().catch(() => undefined)}>重试读取请求</button>}
    </div>}
    <div className={`task-panel-layout ${chosen ? 'inspecting' : ''}`}>
      <div className="task-panel-main">
        {mode === 'list' && loading && !tasks.length && <p className="task-empty" role="status">正在读取任务…</p>}
        {mode === 'board' ? <div ref={boardRef} className="task-panel-board" style={{ '--task-column-count': boardColumns.length } as CSSProperties} aria-label="任务状态看板" aria-busy={loading}>
          {boardColumns.map((column) => {
            const items = visible.filter((task) => taskColumn(task, requests) === column.id);
            const ColumnIcon = STATUS_ICONS[column.id];
            const dropAction = dragging ? taskDropAction(dragging, requests, column.id) : null;
            const dropClass = target === column.id ? dropAction?.kind === 'blocked' ? 'drop-blocked' : 'drop-target' : '';
            return <section className={`task-board-column ${column.id} ${dropClass}`} key={column.id} aria-label={column.label} data-column={column.id} onDragOver={(event) => dragOver(event, column.id)} onDrop={(event) => { event.preventDefault(); void drop(column.id); }}>
              <h2><ColumnIcon />{column.label}<span>{items.length}</span></h2>
              {dragging && target === column.id && <p className="task-drop-cue" role="status">{dropAction?.label}</p>}
              {items.map(card)}
              {!items.length && <p className="task-empty">{loading && !tasks.length ? '正在读取任务…' : '暂无任务'}</p>}
            </section>;
          })}
        </div> : <TaskTreeList visible={visible} selected={selected} projectName={projectName} summary={summary} actions={(task) => actions(task, true)} onOpen={openListTask} status={(task) => <span className={`task-status ${taskColumn(task, requests)} ${abnormalTask(task) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>} />}

        {!loading && !visible.length && <p className="task-empty"><Search />没有符合筛选条件的任务</p>}
        {!query.trim() && completed.older.length > 0 && <button type="button" className="inline-link task-history" onClick={() => setHistory(!history)}><ChevronDown />{history ? '收起较早完成任务' : `查看更早的 ${completed.older.length} 个完成任务`}</button>}
        {mode === 'list' && <p className="task-total" aria-label="任务数量">当前显示 {visible.length} / {total} 个任务</p>}
        {nextOffset !== null && <button type="button" className="secondary" disabled={loading} onClick={() => void store.refresh(true)}>{loading ? '读取中…' : '加载更多任务'}</button>}
      </div>
      {chosen && <aside ref={inspectorRef} tabIndex={-1} className="task-inspector" aria-label="任务详情">
        <TaskInspectorContent key={chosen.taskId} task={chosen} detail={detail?.task.taskId === chosen.taskId ? detail : null} requests={requests} project={projectName(chosen)}
          parent={<>{chosen.parentTaskId && <button type="button" className="inline-link task-parent-path" onClick={() => void navigateTask(chosen.parentTaskId!)}>{taskById.get(chosen.parentTaskId)?.title ?? relations[chosen.taskId]?.parent?.title ?? '查看父任务'} /</button>}{sources.length > 0 && <button type="button" className="inline-link task-relation-back" onClick={() => void navigateTask(sources[sources.length - 1]!, true)}>返回「{taskById.get(sources[sources.length - 1]!)?.title ?? '来源任务'}」</button>}</>}
          navigation={<TaskIconButton label="关闭任务详情" onClick={() => { ++navigation.current; setSources([]); store.select(null); }}><X /></TaskIconButton>}
          actions={actions(chosen)} management={management(chosen)}
          relations={<TaskRelations key={chosen.taskId} task={chosen} onOpen={(id) => void navigateTask(id)} onCreateChild={() => { setCreatingParent(chosen); setCreating(true); }} />}
          error={detailError} retry={() => setDetailAttempt((attempt) => attempt + 1)} earlier={() => void earlierProgress()} loadingEarlier={progressLoading === chosen.taskId}
          humanOnlyBusy={busy === chosen.taskId} onHumanOnly={(humanOnly) => void updateHumanOnly(chosen, humanOnly)} onOpenSession={onOpenSession} onPriority={(priority) => void store.update(chosen, { priority }).catch((failure) => setNotice(failure.message))} />
      </aside>}
    </div>
    {creating && <NewTaskDialog {...(creatingParent ? { parentTask: creatingParent } : {})} initialProjectId={project} projects={workspaces?.filter((workspace) => workspace.project).map((workspace) => ({ id: workspace.project!.projectId, name: workspace.name })) ?? []} onClose={() => { setCreating(false); setCreatingParent(null); }} onCreated={(task) => { setCreating(false); setCreatingParent(null); void navigateTask(task.taskId); }} />}
  </div>;
}
