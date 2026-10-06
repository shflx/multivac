import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, CircleX, FileText, MessageSquare, MoreHorizontal, Trash2, X } from 'lucide-react';
import { presentTask } from './task-panel-state.js';
import { relationEditReason } from './task-relations.js';
import { TaskRelations } from './task-relationship-fields.jsx';
import { TaskRequestCard } from './task-request-card.jsx';

/** 与 dev 相同：当前情况和决策优先，长目标、执行信息与历史按需展开。 */
export function TaskInspector({ task, tasks, projects, requests, outputs, actions, onSelect, onNavigate, onBack, onCreateChild, updateTask, onCancel, onDelete, onHumanComplete, onSession, onOutput, directoryOf, resolveRequest, drafts, updateDraft, IconButton }) {
  const [goalExpanded, setGoalExpanded] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const [menu, setMenu] = useState(false);
  const terminal = ['done', 'cancelled'].includes(task.status);
  const pending = requests.filter((request) => request.taskId === task.id && request.state !== 'done');
  const state = presentTask(task, requests);
  const project = projects.find((item) => item.id === task.projectId);
  const events = [...(task.events || [])].reverse();
  const ownOutputs = outputs.filter((item) => item.taskId === task.id && !pending.some((request) => request.type === '验收' && request.evidence?.outputId === item.id));
  const longGoal = task.goal?.length > 120 || task.goal?.split('\n').length > 3;
  return <aside className="task-inspector" aria-label="任务详情" tabIndex={-1}>
    {onBack && <button type="button" className="inline-link" onClick={onBack}><ArrowLeft />返回来源任务</button>}
    <header><h2>{task.title}</h2><div className="task-inspector-controls"><IconButton label="更多任务操作" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal /></IconButton><IconButton label="关闭任务详情" onClick={() => onSelect(null)}><X /></IconButton></div></header>
    {menu && <div className="task-management-actions" role="group" aria-label="更多任务操作" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); } }}>
      {!terminal && <button className="inline-link task-cancel-action" onClick={() => { onCancel(task.id); setMenu(false); }}><CircleX />取消任务</button>}
      <button className="inline-link task-cancel-action" disabled={!['idle', 'paused', 'failed', 'done', 'cancelled'].includes(task.status)} onClick={() => onDelete(task)}><Trash2 />删除任务</button>
    </div>}
    <div className="task-inspector-meta"><span>{project?.name || '日常'}</span><label>优先级 <select aria-label="任务优先级" value={task.priority} disabled={terminal} onChange={(event) => updateTask(task.id, { priority: event.target.value }, `优先级已调整为${event.target.value}`)}><option>高</option><option>中</option><option>低</option></select></label></div>
    <label className="task-create-acceptance"><input type="checkbox" checked={!!task.humanOnly} disabled={!!relationEditReason(task, requests) || !!task.hasRun} onChange={(event) => updateTask(task.id, { humanOnly: event.target.checked }, event.target.checked ? '你选择由自己处理' : '你选择交给 Agent 处理')} /><span>我来处理</span></label>
    {task.humanOnly && <p className="task-panel-muted">由你完成，Agent 不会执行；处理后可标记完成。</p>}
    <section aria-label="当前情况"><span className={`task-panel-status ${state.tone}`}>{state.label}</span><p>{task.reason}</p><div className="task-detail-actions">{task.humanOnly && !terminal && !pending.length ? <button className="primary" onClick={() => onHumanComplete(task)}>标记完成</button> : !pending.length ? actions : null}{task.hasRun && <button className="inline-link" onClick={() => onSession(task)}><MessageSquare />打开任务会话</button>}</div></section>
    {pending.map((request) => ['工具授权', '外发授权'].includes(request.type) ? <section key={request.id}><h3>{request.title}</h3><p>{request.detail}</p><button className="primary" onClick={() => onSession(task)}>在会话中处理授权</button></section> : <TaskRequestCard key={request.id} request={request} output={outputs.find((item) => item.id === request.evidence?.outputId) || outputs.find((item) => item.taskId === task.id)} resolveRequest={resolveRequest} draft={drafts[request.id] || {}} updateDraft={(patch) => updateDraft(request.id, patch)} onOutput={onOutput} />)}
    <section><h3>目标</h3><p className={`task-goal ${longGoal && !goalExpanded ? 'collapsed' : ''}`}>{task.goal || task.title}</p>{longGoal && <button type="button" className="inline-link" aria-expanded={goalExpanded} onClick={() => setGoalExpanded(!goalExpanded)}>{goalExpanded ? '收起目标' : '展开目标'}</button>}</section>
    {!!ownOutputs.length && <section><h3>{pending.some((request) => request.type === '验收') ? '其他成果' : '成果'}</h3>{ownOutputs.map((output) => <button className="task-output-link" key={output.id} onClick={() => onOutput(output.id)}><FileText /><span><strong>{output.title}</strong><small>{output.summary}</small></span><ArrowRight /></button>)}</section>}
    <TaskRelations task={task} tasks={tasks} requests={requests} onOpen={onNavigate} onCreateChild={onCreateChild} onUpdate={updateTask} />
    <section><details><summary>范围、目录与执行信息</summary><dl className="task-properties"><div><dt>范围</dt><dd>{task.scope || '未指定'}</dd></div><div><dt>目录</dt><dd>{task.humanOnly ? '无需 Agent 执行目录' : task.hasRun ? directoryOf(task).path : '尚未准备'}</dd></div><div><dt>验收</dt><dd>{task.humanOnly ? '由你确认完成' : task.acceptance ? '需要人工验收' : '成果内容非空'}</dd></div><div><dt>下一步</dt><dd>{task.next || '暂无'}</dd></div><div><dt>运行</dt><dd>{task.hasRun ? task.reason : '暂无执行记录'}</dd></div></dl></details></section>
    {!!events.length && <section><h3>最近进展</h3><ol className="task-events">{(allEvents ? events : events.slice(0, 4)).map((event, index) => <li key={`${event.at}:${index}`}><time>{new Date(event.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><span>{event.title}</span></li>)}</ol>{events.length > 4 && <button className="inline-link" aria-expanded={allEvents} onClick={() => setAllEvents(!allEvents)}>{allEvents ? '收起进展' : '查看全部进展'}</button>}</section>}
  </aside>;
}
