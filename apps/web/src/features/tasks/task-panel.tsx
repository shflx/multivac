import { useEffect, useState } from 'react';
import { Columns3, List, Search, Plus, X, Play, Pause, CircleX, FileText, MessageSquare, RefreshCw, ChevronDown } from 'lucide-react';
import type { Task, TaskDetail, TaskControl } from '@multivac/contracts';
import { ManagementPageActions } from '../../app/management-layout.js';
import { useWorkspaces } from '../workspace/workspace-sessions-provider.js';
import { useTasks } from './tasks-provider.js';
import { useTaskRequests } from './task-requests-provider.js';
import { TaskRequestCard } from './task-request-card.js';
import { ArtifactPreview } from './artifact-preview.js';
import { TASK_COLUMNS, taskColumn, taskLabel, splitCompleted, matchesTask } from './task-panel-state.js';

const PRIORITIES = { high: '高', medium: '中', low: '低' };
export function TaskPanel({ active, onOpenSession, onSelectionChange }: { active: boolean; onOpenSession: (id: string) => void; onSelectionChange?: (id: string | null) => void }) {
  const { store, tasks, selected, total, nextOffset, loading, error } = useTasks();
  const { requests } = useTaskRequests();
  const { workspaces, ensureLoaded } = useWorkspaces();
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('all');
  const [status, setStatus] = useState('all');
  const [mode, setMode] = useState<'board' | 'list'>('board');
  const [history, setHistory] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  useEffect(() => { if (active) { store?.ensure(); void ensureLoaded().catch(() => undefined); } }, [active, store, ensureLoaded]);
  const matching = tasks.filter((task) => matchesTask(task, query, project, status, requests));
  const completed = splitCompleted(matching);
  const visible = !history && !query.trim() ? matching.filter((task) => !completed.older.includes(task)) : matching;
  useEffect(() => { if (selected && !visible.some((task) => task.taskId === selected)) store?.select(null); }, [selected, visible, store]);
  const chosen = tasks.find((task) => task.taskId === selected);
  useEffect(() => { onSelectionChange?.(selected); }, [selected, onSelectionChange]);
  useEffect(() => {
    let current = true;
    if (!selected || !store) { setDetail(null); return; }
    void store.detail(selected).then((value) => { if (current) setDetail(value); }).catch((failure) => { if (current) setNotice(failure instanceof Error ? failure.message : '详情未读取。'); });
    return () => { current = false; };
  }, [selected, chosen?.revision, store]);
  if (!store) return null;
  const projectName = (task: Task) => workspaces?.find((workspace) => workspace.project?.projectId === task.projectId)?.name ?? (task.projectId ? '项目已失效' : '日常');
  async function act(task: Task, action: TaskControl['action']) {
    if (busy) return;
    setBusy(task.taskId); setNotice('');
    try { await store!.control(task, action); }
    catch (failure) { setNotice(failure instanceof Error ? failure.message : '操作未执行。'); }
    finally { setBusy(null); }
  }
  const actions = (task: Task) => <div className="task-actions">
    {['idle', 'failed'].includes(task.status) && <button type="button" title="启动任务" aria-label={`启动任务：${task.title}`} disabled={busy === task.taskId} onClick={() => void act(task, 'start')}><Play /></button>}
    {task.status === 'paused' && <button type="button" title="继续执行" aria-label={`继续任务：${task.title}`} disabled={busy === task.taskId} onClick={() => void act(task, 'resume')}><Play /></button>}
    {['queued', 'running', 'waiting'].includes(task.status) && <button type="button" title="暂停任务" aria-label={`暂停任务：${task.title}`} disabled={busy === task.taskId} onClick={() => void act(task, 'pause')}><Pause /></button>}
    {!['done', 'cancelled'].includes(task.status) && <button type="button" title="取消任务" aria-label={`取消任务：${task.title}`} disabled={busy === task.taskId} onClick={() => void act(task, 'cancel')}><CircleX /></button>}
    {task.sessionId && <button type="button" title="进入执行会话" aria-label={`打开任务会话：${task.title}`} onClick={() => onOpenSession(task.sessionId!)}><MessageSquare /></button>}
  </div>;
  const card = (task: Task) => <article key={task.taskId} className={`task-board-card ${selected === task.taskId ? 'selected' : ''}`} data-task-id={task.taskId}>
    <button type="button" className="task-card-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected === task.taskId} onClick={() => { setOutput(null); store.select(task.taskId); }}>
      <span className="task-card-meta">{projectName(task)}<span className={`task-status ${taskColumn(task, requests)}`}>{taskLabel(task, requests)}</span></span>
      <strong title={task.title}>{task.title}</strong><p title={task.reason}>{task.reason}</p>
    </button>{actions(task)}
  </article>;
  return <div className="task-panel">
    <ManagementPageActions><button type="button" className="primary" onClick={() => setCreating(true)}><Plus />新建任务</button></ManagementPageActions>
    <div className="task-panel-toolbar">
      <label className="task-panel-search"><Search /><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="task-select">项目<select aria-label="任务项目筛选" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">全部项目</option><option value="daily">日常</option>{workspaces?.filter((workspace) => workspace.project).map((workspace) => <option key={workspace.workspaceId} value={workspace.project!.projectId}>{workspace.name}</option>)}</select></label>
      <label className="task-select">状态<select aria-label="任务状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="unfinished">未完成</option>{TASK_COLUMNS.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}</select></label>
      <div className="task-view-modes" role="group" aria-label="任务视图"><button type="button" title="看板" aria-label="任务看板" aria-pressed={mode === 'board'} onClick={() => setMode('board')}><Columns3 /></button><button type="button" title="列表" aria-label="任务列表" aria-pressed={mode === 'list'} onClick={() => setMode('list')}><List /></button></div>
      <button type="button" className="icon-button" aria-label="刷新任务" title="刷新任务" onClick={() => void store.refresh()}><RefreshCw /></button>
      <span className="task-total">{visible.length} / {total}</span>
    </div>
    {(notice || error) && <p className="task-panel-error" role="alert">{notice || error}</p>}
    <div className={`task-panel-layout ${chosen ? 'inspecting' : ''}`}>
      <div className="task-panel-main">
        {loading && !tasks.length && <p className="task-empty">正在读取任务…</p>}
        {mode === 'board' ? <div className="task-panel-board" aria-label="任务状态看板">{TASK_COLUMNS.map((column) => <section className={`task-board-column ${column.id}`} key={column.id} aria-label={column.label} data-column={column.id}><h2>{column.label}<span>{visible.filter((task) => taskColumn(task, requests) === column.id).length}</span></h2>{visible.filter((task) => taskColumn(task, requests) === column.id).map(card)}{!visible.some((task) => taskColumn(task, requests) === column.id) && <p className="task-empty">暂无任务</p>}</section>)}</div> : <div className="task-panel-list">{[...new Set(visible.map(projectName))].map((name) => <section key={name}><h2>{name}</h2>{visible.filter((task) => projectName(task) === name).map((task) => <div className={`task-list-row ${selected === task.taskId ? 'selected' : ''}`} key={task.taskId}><button type="button" onClick={() => { setOutput(null); store.select(task.taskId); }}><strong>{task.title}</strong><span>{task.reason}</span></button><span className={`task-status ${taskColumn(task, requests)}`}>{taskLabel(task, requests)}</span>{actions(task)}</div>)}</section>)}</div>}
        {!loading && !visible.length && <p className="task-empty"><Search />没有符合筛选条件的任务</p>}
        {!query.trim() && completed.older.length > 0 && <button type="button" className="inline-link task-history" onClick={() => setHistory(!history)}><ChevronDown />{history ? '收起较早完成任务' : `查看更早的 ${completed.older.length} 个完成任务`}</button>}
        {nextOffset !== null && <button type="button" className="secondary" disabled={loading} onClick={() => void store.refresh(true)}>{loading ? '读取中…' : '加载更多任务'}</button>}
      </div>
      {chosen && <aside className="task-inspector" aria-label="任务详情"><header><h2>{chosen.title}</h2><button type="button" className="icon-button" title="关闭任务详情" aria-label="关闭任务详情" onClick={() => store.select(null)}><X /></button></header><p className="task-goal">{chosen.goal}</p>
        <section><h3>当前情况</h3><span className={`task-status ${taskColumn(chosen, requests)}`}>{taskLabel(chosen, requests)}</span><p>{chosen.reason}</p></section>
        <section><h3>下一步</h3><p>{chosen.nextStep}</p>{actions(chosen)}</section>
        <section><h3>成果</h3>{detail?.artifacts?.length ? detail.artifacts.map((version) => <button type="button" className="task-output-link" key={version.versionId} onClick={() => setOutput(output === version.versionId ? null : version.versionId)}><FileText /><span>{version.title}<small>版本 {version.version} · {version.status === 'accepted' ? '已验收' : version.status === 'changes' ? '待修改' : '待核对'}</small></span></button>) : <p className="task-muted">暂无成果</p>}{output && <ArtifactPreview versionId={output} />}</section>
        {requests.filter((request) => request.taskId === chosen.taskId && request.status === 'pending' && request.kind !== 'authorization').map((request) => <TaskRequestCard key={request.requestId} request={request} />)}
        <section><h3>任务属性</h3><dl className="task-properties"><div><dt>项目</dt><dd>{projectName(chosen)}</dd></div><div><dt>优先级</dt><dd><select aria-label="任务优先级" value={chosen.priority} disabled={['done', 'cancelled'].includes(chosen.status)} onChange={(event) => void store.update(chosen, { priority: event.target.value as Task['priority'] }).catch((failure) => setNotice(failure.message))}>{Object.entries(PRIORITIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></dd></div></dl><details><summary>范围、目录与执行信息</summary><dl className="task-properties"><div><dt>范围</dt><dd>{chosen.scope || '本任务独立目录'}</dd></div><div><dt>目录</dt><dd>{detail?.runs?.[0]?.directory?.path ?? '尚未准备'}</dd></div><div><dt>验收</dt><dd>{chosen.acceptance ? '需要人工验收' : chosen.acceptanceCriteria || '待明确自检要求'}</dd></div><div><dt>依赖</dt><dd>{chosen.dependencyIds.map((id) => tasks.find((task) => task.taskId === id)?.title ?? id).join('、') || '无'}</dd></div><div><dt>运行</dt><dd>{detail?.runs?.[0]?.reason ?? '暂无执行记录'}</dd></div></dl></details></section>
        <section><h3>最近进展</h3><ol className="task-events">{detail?.events.map((event) => <li key={event.eventId}><time>{new Date(event.occurredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>{event.summary}</span></li>)}</ol>{detail?.nextEventBefore && <button type="button" className="inline-link" onClick={() => void store.detail(chosen.taskId, detail.nextEventBefore!).then((value) => setDetail({ ...detail, events: [...detail.events, ...value.events], nextEventBefore: value.nextEventBefore }))}>更早进展</button>}</section>
      </aside>}
    </div>
    {creating && <NewTaskDialog projects={workspaces?.filter((workspace) => workspace.project).map((workspace) => ({ id: workspace.project!.projectId, name: workspace.name })) ?? []} onClose={() => setCreating(false)} onCreated={(task) => { setCreating(false); setQuery(''); setProject('all'); setStatus('all'); store.select(task.taskId); }} />}
  </div>;
}

function NewTaskDialog({ projects, onClose, onCreated }: { projects: { id: string; name: string }[]; onClose: () => void; onCreated: (task: Task) => void }) {
  const { store } = useTasks();
  const [title, setTitle] = useState(''); const [goal, setGoal] = useState(''); const [scope, setScope] = useState(''); const [projectId, setProjectId] = useState('daily');
  const [acceptance, setAcceptance] = useState(true); const [criteria, setCriteria] = useState(''); const [priority, setPriority] = useState<Task['priority']>('medium');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { const prior = document.activeElement as HTMLElement | null; return () => prior?.focus(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!store || busy) return;
    setBusy(true); setError('');
    try { onCreated(await store.create({ commandId: crypto.randomUUID(), title, goal, scope, priority, projectId: projectId === 'daily' ? null : projectId, acceptance, acceptanceCriteria: criteria })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '任务未创建。'); setBusy(false); }
  }
  return <div className="task-dialog-backdrop"><form className="task-dialog" role="dialog" aria-modal="true" aria-label="新建任务" onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === 'Tab') { const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')); const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}><header><h2>新建任务</h2><button type="button" className="icon-button" aria-label="关闭新建任务" onClick={onClose} disabled={busy}><X /></button></header><label>标题<input autoFocus required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>目标<textarea required maxLength={16000} rows={4} value={goal} onChange={(event) => setGoal(event.target.value)} /></label><div className="task-form-row"><label>项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="daily">日常</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as Task['priority'])}>{Object.entries(PRIORITIES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div><label>范围<textarea rows={2} value={scope} onChange={(event) => setScope(event.target.value)} maxLength={16000} /></label><label className="task-check"><input type="checkbox" checked={acceptance} onChange={(event) => setAcceptance(event.target.checked)} />完成后需要验收</label>{acceptance ? <label>验收要求<textarea rows={2} value={criteria} maxLength={16000} onChange={(event) => setCriteria(event.target.value)} /></label> : <label>自检要求<select required value={criteria} onChange={(event) => setCriteria(event.target.value)}><option value="">选择自检要求</option><option>非空文本</option><option>有效 JSON</option></select></label>}{error && <p role="alert" className="task-panel-error">{error}</p>}<footer><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy || !title.trim() || !goal.trim()}>{busy ? '创建中…' : '创建任务'}</button></footer></form></div>;
}
