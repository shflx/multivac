import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { presentTask } from './task-panel-state.js';
import { relationError, relationEditReason, unmetDependencies } from './task-relations.js';

export function TaskRelationshipFields({ task, tasks, value, onChange, fixedParent = false }) {
  const [query, setQuery] = useState('');
  const candidates = tasks.filter((item) => item.id !== task.id && (item.projectId || null) === (task.projectId || null));
  const parentCandidates = candidates.filter((item) => !relationError(task, { ...value, parentTaskId: item.id }, tasks));
  const dependencyCandidates = candidates.filter((item) => !relationError(task, { ...value, dependencyIds: [...(value.dependencyIds || []), item.id] }, tasks));
  return <div className="task-relationship-fields">
    <label className="task-create-field"><span>父任务</span><select aria-label="父任务" disabled={fixedParent} value={value.parentTaskId || ''} onChange={(event) => onChange({ parentTaskId: event.target.value || null })}><option value="">无父任务</option>{parentCandidates.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <fieldset><legend>前置任务</legend><input type="search" aria-label="搜索前置任务" placeholder="搜索同项目任务" value={query} onChange={(event) => setQuery(event.target.value)} /><div className="task-dependency-options">{dependencyCandidates.filter((item) => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase())).map((item) => <label key={item.id}><input type="checkbox" checked={(value.dependencyIds || []).includes(item.id)} onChange={(event) => onChange({ dependencyIds: event.target.checked ? [...(value.dependencyIds || []), item.id] : value.dependencyIds.filter((id) => id !== item.id) })} /><span>{item.title}</span></label>)}</div>{!dependencyCandidates.length && <p className="task-panel-muted">暂无可选前置任务</p>}</fieldset>
    <p className="task-panel-muted">所有前置任务处于审核中或已完成时即满足执行条件。父子关系只组织目标，不隐含依赖、自动执行或自动完成。</p>
  </div>;
}

export function TaskRelations({ task, tasks, requests, onOpen, onCreateChild, onUpdate }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState('');
  const children = tasks.filter((item) => item.parentTaskId === task.id);
  const unmet = unmetDependencies(task, tasks);
  const reason = relationEditReason(task, requests);
  const link = (id) => {
    const item = tasks.find((candidate) => candidate.id === id);
    if (!item) return <p className="task-panel-muted">关联任务已失效</p>;
    const state = presentTask(item, requests);
    return <button type="button" className="task-relation-link" onClick={() => onOpen(id)}><strong>{item.title}</strong><span className={`task-panel-status ${state.tone}`}>{state.label}</span></button>;
  };
  return <>
    {!!children.length && <section aria-label="直属子任务"><div className="task-relation-heading"><h3>直属子任务</h3><button type="button" className="inline-link" onClick={onCreateChild}><Plus />创建子任务</button></div><p>已完成 {children.filter((item) => item.status === 'done').length} / {children.length}{children.some((item) => item.status === 'cancelled') && ` · 已取消 ${children.filter((item) => item.status === 'cancelled').length}`}</p>{children.map((item) => <React.Fragment key={item.id}>{link(item.id)}</React.Fragment>)}</section>}
    <section aria-label="任务关系"><div className="task-relation-heading"><h3>任务关系</h3>{!children.length && <button type="button" className="inline-link" onClick={onCreateChild}><Plus />创建子任务</button>}<button type="button" className="inline-link" disabled={!!reason || !!draft} title={reason} onClick={() => setDraft({ parentTaskId: task.parentTaskId || null, dependencyIds: task.dependencyIds || [] })}>编辑关系</button></div>
      {draft ? <div onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') setDraft(null); }}><TaskRelationshipFields task={task} tasks={tasks} value={draft} onChange={(patch) => { setDraft({ ...draft, ...patch }); setError(''); }} />{error && <p role="alert">{error}</p>}<div className="task-detail-actions"><button type="button" className="primary" disabled={!!reason} onClick={() => { const problem = relationError(task, draft, tasks); if (problem) { setError(problem); return; } onUpdate(task.id, draft, '任务关系已更新'); setDraft(null); }}>保存关系</button><button type="button" className="secondary" onClick={() => setDraft(null)}>取消编辑</button></div></div> : <>
        {task.parentTaskId && <><h4>父任务</h4>{link(task.parentTaskId)}</>}
        {!!task.dependencyIds?.length && <details open={!!unmet.length}><summary>前置任务 · {task.dependencyIds.length}{!unmet.length && ' · 已满足'}</summary>{task.dependencyIds.map((id) => <React.Fragment key={id}>{link(id)}</React.Fragment>)}</details>}
        {!!unmet.length && <p className="task-panel-muted">{task.status === 'queued' ? '已申请执行，' : '尚未申请执行，'}等待 {unmet.length} 个前置任务进入审核中或已完成。</p>}
        {reason && <p className="task-panel-muted">{reason}</p>}
      </>}
    </section>
  </>;
}
