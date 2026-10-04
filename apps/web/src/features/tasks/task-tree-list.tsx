import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { Task } from '@multivac/contracts';
import { useTasks } from './tasks-provider.js';
import { TaskRelationQuery } from './task-relation-queries.js';
import { taskTreeRows } from './task-tree-state.js';

export function TaskTreeList({ visible, selected, projectName, summary, status, actions, onOpen }: {
  visible: readonly Task[]; selected: string | null; projectName: (task: Task) => string;
  summary: (task: Task) => string; status: (task: Task) => ReactNode; actions: (task: Task) => ReactNode; onOpen: (id: string) => void;
}) {
  const { store, tasks, relations, relationVersion } = useTasks();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const readers = useRef(new Map<string, { reader: TaskRelationQuery; unsubscribe: () => void }>());
  const [, render] = useState(0);
  useEffect(() => { for (const { reader } of readers.current.values()) void reader.refresh(); }, [relationVersion]);
  useEffect(() => { const queries = readers.current; return () => { for (const value of queries.values()) { value.unsubscribe(); value.reader.dispose(); } queries.clear(); }; }, []);
  const cache = new Map(tasks.map((task) => [task.taskId, task]));
  const memberships = new Map([...readers.current].map(([id, { reader }]) => [id, reader.snapshot().ids]));
  const rows = taskTreeRows(visible.map((task) => task.taskId), cache, expanded, memberships);
  function toggle(id: string) {
    if (!store) return;
    const next = new Set(expanded);
    if (next.delete(id)) { const previous = readers.current.get(id); previous?.unsubscribe(); previous?.reader.dispose(); readers.current.delete(id); }
    else {
      next.add(id);
      const reader = new TaskRelationQuery(store, { parentTaskId: id });
      const unsubscribe = reader.subscribe(() => render((value) => value + 1));
      readers.current.set(id, { reader, unsubscribe });
      void reader.refresh();
    }
    setExpanded(next);
  }
  const presentedIds = new Set(rows.map((row) => row.id));
  const groups = [...new Set(rows.map((row) => cache.get(row.id)!.projectId))];
  return <div className="task-panel-list">{rows.some((row) => row.context) && <p className="task-muted task-tree-context-hint">关系上下文含筛选外的子任务，数量仍按筛选结果计算。</p>}{groups.map((projectId) => <section key={projectId ?? 'daily'}>
    <h2><Folder />{projectName(cache.get(rows.find((row) => cache.get(row.id)!.projectId === projectId)!.id)!)}</h2>
    {rows.filter((row) => cache.get(row.id)!.projectId === projectId).map((row) => {
      const task = cache.get(row.id)!;
      const facts = relations[row.id];
      const query = readers.current.get(row.id)?.reader;
      const page = query?.snapshot();
      return <div key={row.id} className="task-tree-entry" data-depth={row.depth} style={{ '--task-depth': Math.min(row.depth, 12) } as CSSProperties}>
        <div className={`task-list-row ${selected === row.id ? 'selected' : ''} ${row.context ? 'relation-context' : ''}`}>
          <button type="button" className="task-tree-toggle" aria-label={`${expanded.has(row.id) ? '收起' : '展开'}子任务：${task.title}`} aria-expanded={expanded.has(row.id)} disabled={facts?.children.total === 0 && !expanded.has(row.id)} onClick={() => toggle(row.id)}>{expanded.has(row.id) ? <ChevronDown /> : <ChevronRight />}</button>
          <button type="button" className="task-tree-open" aria-label={`查看任务：${task.title}`} aria-pressed={selected === row.id} onClick={() => onOpen(row.id)}><strong>{task.title}{task.humanOnly && <small>我来处理</small>}{row.context && <small>关系上下文</small>}</strong>{summary(task) && <span title={summary(task)}>{summary(task)}</span>}
            {!!facts?.children.total && <small>子任务已完成 {facts.children.done} / {facts.children.total}{facts.children.cancelled > 0 && ` · 已取消 ${facts.children.cancelled}`}</small>}
          </button>
          {status(task)}{actions(task)}
        </div>
        {!row.depth && task.parentTaskId && !presentedIds.has(task.parentTaskId) && <div className="task-tree-parent"><button type="button" className="inline-link" onClick={() => onOpen(task.parentTaskId!)}>父任务：{cache.get(task.parentTaskId)?.title ?? (facts?.parent?.taskId === task.parentTaskId ? facts.parent.title : task.parentTaskId)}</button></div>}
        {page && <div className="task-tree-page">{page.loading && <span role="status">正在读取子任务…</span>}{page.error && <span role="alert">{page.error}<button type="button" className="inline-link" onClick={() => void query?.refresh()}>重试子任务</button></span>}
          {page.nextOffset !== null && <button type="button" className="inline-link" disabled={page.loading} aria-label={`加载更多子任务：${task.title}`} onClick={() => void query?.refresh(true)}>加载更多子任务（{page.ids.length} / {page.total}）</button>}
          {!page.loading && !page.error && !page.total && <span className="task-muted">暂无直属子任务</span>}
        </div>}
      </div>;
    })}
  </section>)}</div>;
}
