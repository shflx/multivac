import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Task } from '@multivac/contracts';
import { Plus } from 'lucide-react';
import { AssistantApiError } from '../../data/assistant-api.js';
import { useTasks } from './tasks-provider.js';
import { TaskRelationContext } from './task-relation-queries.js';
import { useRelationQuery } from './task-picker.js';
import { TaskRelationshipFields } from './task-relationship-fields.js';
import { taskColumn, taskLabel } from './task-panel-state.js';
import { useTaskRequests } from './task-requests-provider.js';

/** 关系任务整行可打开，标题与真实状态各占一列。 */
function RelationTaskButton({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const { requests } = useTaskRequests();
  return <button type="button" className="task-relation-link task-relation-row" onClick={() => onOpen(task.taskId)}>
    <strong title={task.title}>{task.title}</strong>
    <span className={`task-status ${taskColumn(task, requests)} ${['failed', 'recovery'].includes(task.status) ? 'danger' : ''}`}>{taskLabel(task, requests)}</span>
  </button>;
}

function ChildTasks({ taskId, onOpen }: { taskId: string; onOpen: (id: string) => void }) {
  const { tasks } = useTasks();
  const page = useRelationQuery({ parentTaskId: taskId });
  const cache = new Map(tasks.map((task) => [task.taskId, task]));
  return <div className="task-relation-page">
    <ul className="task-relation-items">{page.ids.map((id) => {
      const task = cache.get(id);
      if (!task || task.parentTaskId !== taskId) return null;
      return <li key={id}><RelationTaskButton task={task} onOpen={onOpen} /></li>;
    })}</ul>
    {page.loading && <p role="status">正在读取子任务…</p>}
    {page.error && <p role="alert">{page.error}<button type="button" className="inline-link" onClick={() => void page.reader?.refresh()}>重试关系列表</button></p>}
    {!page.loading && !page.error && !page.ids.length && <p className="task-muted">暂无直属子任务</p>}
    {page.nextOffset !== null && <button type="button" className="inline-link" disabled={page.loading} onClick={() => void page.reader?.refresh(true)}>加载更多子任务</button>}
    {page.nextOffset !== null && <small className="task-muted">已读取 {page.ids.length} / {page.total} 项</small>}
  </div>;
}

/** 编辑基于打开时的 revision；外部更新只更新事实，保留本地待保存的选择。 */
export function TaskRelations({ task, onOpen, onCreateChild }: { task: Task; onOpen: (id: string) => void; onCreateChild: () => void }) {
  const { store, tasks, relationVersion } = useTasks();
  const reader = useMemo(() => store ? new TaskRelationContext(store, task.taskId) : null, [store, task.taskId]);
  const context = useSyncExternalStore(reader!.subscribe, reader!.snapshot);
  useEffect(() => { void reader?.refresh(); return () => reader?.dispose(); }, [reader, relationVersion, task.revision]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const submitting = useRef(false);
  const command = useRef<{ key: string; commandId: string } | null>(null);
  const region = useRef<HTMLElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (error && !busy && !saveButton.current?.disabled) saveButton.current?.focus(); }, [error, busy]);
  const cache = new Map(tasks.map((item) => [item.taskId, item]));
  const facts = context.value;
  const currentFacts = facts && facts.revision === task.revision && facts.version === relationVersion ? facts : null;
  const ready = !!currentFacts && !context.loading && !context.error;
  const parentTitle = task.parentTaskId ? cache.get(task.parentTaskId)?.title ?? (currentFacts?.summary.parent?.taskId === task.parentTaskId ? currentFacts.summary.parent.title : null) : null;
  const invalid = [parent, ...dependencies].some((id) => id && (!cache.has(id) || cache.get(id)!.projectId !== task.projectId));
  const parentInvalid = !!facts?.parentChangeReason && parent !== task.parentTaskId;
  const patch = { parentTaskId: parent, dependencyIds: [...dependencies].sort() };
  const key = JSON.stringify({ revision: editing?.revision, patch });
  const retryable = !!error && !conflict && command.current?.key === key;
  function begin() { setEditing(task); setParent(task.parentTaskId); setDependencies([...task.dependencyIds]); setError(''); setConflict(false); command.current = null; }
  function end() { setEditing(null); setError(''); setConflict(false); requestAnimationFrame(() => { if (editButton.current && !editButton.current.disabled) editButton.current.focus(); else region.current?.focus({ preventScroll: true }); }); }
  async function save() {
    if (!store || !editing || submitting.current || conflict || (!retryable && (!ready || facts?.editReason || invalid || parentInvalid || editing.revision !== task.revision))) return;
    submitting.current = true; setBusy(true); setError('');
    if (command.current?.key !== key) command.current = { key, commandId: crypto.randomUUID() };
    try { await store.update(editing, patch, command.current.commandId); end(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : '关系未保存。');
      if (failure instanceof AssistantApiError && failure.code === 'TASK_CONFLICT') { setConflict(true); void reader?.refresh(); }
    } finally { submitting.current = false; setBusy(false); }
  }
  function link(id: string) {
    const item = cache.get(id);
    return item ? <RelationTaskButton task={item} onOpen={onOpen} />
      : <span className="task-muted">任务已失效或尚未读取</span>;
  }
  const unmet = facts && ready ? facts.summary.dependencies.total - facts.summary.dependencies.done : 0;
  return <>
    {(!currentFacts || currentFacts.summary.children.total > 0) && <section aria-label="直属子任务"><div className="task-relation-heading"><h3>直属子任务</h3><button type="button" className="inline-link" onClick={onCreateChild}><Plus />创建子任务</button></div>
      {!!currentFacts?.summary.children.total && <p className="task-child-progress">已完成 {currentFacts.summary.children.done} / {currentFacts.summary.children.total}{currentFacts.summary.children.cancelled > 0 && ` · 已取消 ${currentFacts.summary.children.cancelled}`}</p>}
      {(!currentFacts || currentFacts.summary.children.total > 0) && <ChildTasks taskId={task.taskId} onOpen={onOpen} />}
    </section>}
    <section ref={region} tabIndex={-1} className="task-relations" aria-label="任务关系"><div className="task-relation-heading"><h3>任务关系</h3>{currentFacts?.summary.children.total === 0 && <button type="button" className="inline-link" onClick={onCreateChild}><Plus />创建子任务</button>}<button ref={editButton} type="button" className="inline-link" disabled={!ready || !!facts?.editReason || !!editing} onClick={begin}>编辑关系</button></div>
      {context.loading && <p role="status">正在核对任务关系…</p>}
      {context.error && <p role="alert">{context.error}<button type="button" className="inline-link" onClick={() => void reader?.refresh()}>重试任务关系</button></p>}
      {currentFacts?.editReason && <details open={!!editing || undefined}><summary>关系修改限制</summary><p className="task-muted">{currentFacts.editReason}</p></details>}
      {editing ? <div className="task-relation-editor" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); end(); } }}>
        <TaskRelationshipFields taskId={task.taskId} projectId={task.projectId} parentTaskId={parent} dependencyIds={dependencies} onParent={setParent} onDependencies={setDependencies} disabled={busy || !ready || !!facts?.editReason} parentReason={facts?.parentChangeReason ?? null} />
        {parentInvalid && <p className="task-muted">当前父关系不可更改，待保存的选择仍保留。<button type="button" className="inline-link" disabled={busy || !ready} onClick={() => setParent(task.parentTaskId)}>恢复当前父任务</button></p>}
        {error && <p role="alert" className="task-create-error">{error}</p>}
        {(conflict || editing.revision !== task.revision) && <div className="task-relation-conflict"><p>任务已更新，你的选择仍保留。当前父任务：{task.parentTaskId ? cache.get(task.parentTaskId)?.title ?? task.parentTaskId : '无'}；当前前置任务：{task.dependencyIds.map((id) => cache.get(id)?.title ?? id).join('、') || '无'}。核对后再保存。</p><button type="button" className="inline-link" disabled={!ready || busy || !!facts?.editReason} onClick={() => { setEditing(task); setConflict(false); setError(''); command.current = null; }}>使用最新版本重新核对</button></div>}
        <div className="task-relation-controls"><button ref={saveButton} type="button" className="primary-button" disabled={busy || conflict || (!retryable && (!ready || !!facts?.editReason || editing.revision !== task.revision || invalid || parentInvalid))} onClick={() => void save()}>{busy ? '保存中…' : retryable ? '重试保存' : '保存关系'}</button><button type="button" className="secondary-button" disabled={busy} onClick={end}>取消编辑</button></div>
      </div> : <>
        {task.parentTaskId && <><h4>父任务</h4>{parentTitle ? <button type="button" className="task-relation-link" onClick={() => onOpen(task.parentTaskId!)}><strong>{parentTitle}</strong></button> : <p className="task-muted">{context.loading ? '正在读取父任务' : '父任务暂不可用'}</p>}</>}
        {task.dependencyIds.length > 0 && <details open={unmet > 0 || undefined}><summary>前置任务 · {task.dependencyIds.length}{ready && !unmet ? " · 已满足" : ""}</summary><ul className="task-relation-items">{task.dependencyIds.map((id) => <li key={id}>{facts?.missingDependencyIds.includes(id) ? <span className="task-muted">前置任务已失效</span> : link(id)}</li>)}</ul></details>}
        {!!unmet && <p className="task-dependency-note">{task.status === 'queued' ? `已申请执行，等待 ${unmet} 个前置任务进入审核中或已完成。` : `还有 ${unmet} 个前置任务未满足条件；这是执行条件。${task.status === 'idle' ? '尚未申请执行。' : ''}`}</p>}
      </>}
      {editing && <p className="task-muted">父子关系只组织目标，不隐含依赖、先后顺序或自动执行、自动完成。</p>}
    </section>

  </>;
}
