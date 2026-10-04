import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, FileText, MoreHorizontal } from 'lucide-react';
import type { Task, TaskDetail, HumanRequest } from '@multivac/contracts';
import { TaskRequestCard } from './task-request-card.js';
import { ArtifactPreview } from './artifact-preview.js';
import { taskColumn, taskLabel } from './task-panel-state.js';

/** 详情先呈现当前需要处理的事；长目标、历史版本和进展按需展开。 */
export function TaskInspectorContent({ task, detail, requests, project, parent, navigation, actions, management, relations, error, retry, earlier, loadingEarlier, onPriority, onOpenSession, onHumanOnly, humanOnlyBusy }: {
  task: Task; detail: TaskDetail | null; requests: readonly HumanRequest[]; project: string;
  parent: ReactNode; navigation: ReactNode; actions: ReactNode; management: ReactNode; relations: ReactNode;
  error: string; retry: () => void; earlier: () => void; loadingEarlier: boolean;
  humanOnlyBusy: boolean;
  onHumanOnly: (value: boolean) => void;
  onPriority: (priority: Task['priority']) => void; onOpenSession: (id: string) => void;
}) {
  const [goalExpanded, setGoalExpanded] = useState(false);
  const longGoal = task.goal.length > 120 || task.goal.split('\n').length > 3;
  const [allEvents, setAllEvents] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = requests.filter((request) => request.taskId === task.taskId && request.status === 'pending');
  // 待验收版本只在对应请求中呈现，避免同一版本有两份预览和决定入口。
  const reviewIds = new Set(pending.filter((request) => request.kind === 'review').map((request) => request.artifactVersionId));
  const artifacts = [...(detail?.artifacts ?? [])].filter((version) => !reviewIds.has(version.versionId)).sort((a, b) => b.version - a.version);
  const artifact = (version: NonNullable<TaskDetail['artifacts']>[number]) => <button type="button" className="task-output-link" key={version.versionId} onClick={() => setOutput(output === version.versionId ? null : version.versionId)}><FileText /><span><strong>{version.title}</strong><small>版本 {version.version} · {version.status === 'accepted' ? '已验收' : version.status === 'changes' ? '待修改' : '待核对'}</small></span><ArrowRight /></button>;
  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setMenuOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);
  return <>
    {parent}
    <header className="task-inspector-heading"><h2>{task.title}</h2><div className="task-inspector-controls">
      <button ref={trigger} type="button" className="icon-button" aria-label="更多任务操作" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal /></button>
      {navigation}
      {menuOpen && <div ref={menu} className="task-management-popover" role="group" aria-label="更多任务操作" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) setMenuOpen(false); }} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); trigger.current?.focus(); } }} onClick={(event) => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) { trigger.current?.focus(); setMenuOpen(false); } }}>{management}</div>}
    </div></header>
    <div className="task-inspector-meta"><span>{project}</span><label>优先级 <select aria-label="任务优先级" value={task.priority} disabled={['done', 'cancelled'].includes(task.status)} onChange={(event) => onPriority(event.target.value as Task['priority'])}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div>
    <label className="task-create-acceptance"><input type="checkbox" checked={!!task.humanOnly} disabled={humanOnlyBusy || !['idle', 'paused', 'failed'].includes(task.status) || !detail || !!detail.runs?.length || pending.length > 0} onChange={(event) => onHumanOnly(event.target.checked)} /><span>我来处理</span></label>
    {task.humanOnly && <p className="task-muted">由你完成，Agent 不会执行；处理后可标记完成。</p>}
    {error && <div className="task-panel-error" role="alert"><span>{error}</span><button type="button" className="inline-link" onClick={retry}>重试任务详情</button></div>}
    <section className="task-current" aria-label="当前情况"><span className={`task-status ${taskColumn(task, requests)} ${['failed', 'recovery'].includes(task.status) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>{task.reason && <p>{task.reason}</p>}{actions}</section>
    {pending.length > 1 && <p className="task-muted">有 {pending.length} 项需要处理</p>}
    {pending.filter((request) => request.kind !== 'authorization').map((request) => <TaskRequestCard key={request.requestId} request={request} />)}
    {task.completionReport && <section aria-label="工作会话完成说明"><h3>完成说明</h3>{!pending.some((request) => request.completionReportId === task.completionReport!.reportId) && <p className="task-goal">{task.completionReport.summary}</p>}{task.status === 'paused' && task.feedback && <p className="task-goal">修改意见：{task.feedback}</p>}<button type="button" className="inline-link" onClick={() => onOpenSession(task.completionReport!.sessionId)}>查看来源会话</button></section>}
    <section className="task-goal-section"><h3>目标</h3><p className={goalExpanded || !longGoal ? 'task-goal' : 'task-goal collapsed'}>{task.goal}</p>{longGoal && <button type="button" className="inline-link" aria-expanded={goalExpanded} onClick={() => setGoalExpanded(!goalExpanded)}>{goalExpanded ? '收起目标' : '展开目标'}</button>}</section>
    {!detail && !error && <p className="task-muted" role="status">正在读取任务详情…</p>}
    {artifacts.length > 0 && <section aria-label="成果"><h3>{reviewIds.size ? '其他成果' : '成果'}</h3>{artifact(artifacts[0]!)}{artifacts.length > 1 && <details><summary>历史成果 · {artifacts.length - 1}</summary>{artifacts.slice(1).map(artifact)}</details>}{output && !reviewIds.has(output) && <ArtifactPreview versionId={output} />}</section>}
    {relations}
    <section><details><summary>范围、目录与执行信息</summary><dl className="task-properties"><div><dt>范围</dt><dd>{task.scope || (task.humanOnly ? '未指定' : '本任务独立目录')}</dd></div><div><dt>目录</dt><dd>{task.humanOnly ? '无需 Agent 执行目录' : detail?.runs?.[0]?.directory?.path ?? (detail ? '尚未准备' : '读取中…')}</dd></div><div><dt>验收</dt><dd>{task.humanOnly ? '由你确认完成' : task.acceptance ? '需要人工验收' : task.acceptanceCriteria || '待明确自检要求'}</dd></div><div><dt>下一步</dt><dd>{task.nextStep || '暂无'}</dd></div><div><dt>运行</dt><dd>{detail?.runs?.[0]?.reason ?? (detail ? '暂无执行记录' : '读取中…')}</dd></div></dl></details></section>
    {!!detail?.events.length && <section><h3>最近进展</h3><ol className="task-events">{(allEvents ? detail.events : detail.events.slice(0, 4)).map((event) => <li key={event.eventId}><time>{new Date(event.occurredAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>{event.summary}</span></li>)}</ol>{(detail.events.length > 4 || detail.nextEventBefore) && <button type="button" className="inline-link" aria-expanded={allEvents} onClick={() => setAllEvents(!allEvents)}>{allEvents ? '收起进展' : '查看全部进展'}</button>}{allEvents && detail.nextEventBefore && <button type="button" className="inline-link" disabled={loadingEarlier} onClick={earlier}>{loadingEarlier ? '读取中…' : '更早进展'}</button>}</section>}
  </>;
}
