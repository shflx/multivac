import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Task, TaskQuery } from '@multivac/contracts';
import { Search, X } from 'lucide-react';
import { useTasks } from './tasks-provider.js';
import { TaskRelationQuery } from './task-relation-queries.js';
import { taskLabel } from './task-panel-state.js';

const EMPTY = { ids: [] as readonly string[], total: 0, nextOffset: null, loading: false, error: '' };

export function useRelationQuery(query: TaskQuery) {
  const { store, relationVersion } = useTasks();
  const key = JSON.stringify(query);
  const reader = useMemo(() => store ? new TaskRelationQuery(store, JSON.parse(key) as TaskQuery) : null, [store, key]);
  const state = useSyncExternalStore(reader?.subscribe ?? (() => () => undefined), reader?.snapshot ?? (() => EMPTY));
  useEffect(() => { void reader?.refresh(); return () => reader?.dispose(); }, [reader, relationVersion]);
  return { ...state, reader };
}

/** 服务端完整集合内按身份选择；普通按钮保持模态层既有的 Tab 顺序。 */
export function TaskPicker({ label, projectId, excludeIds, candidateFor, relation, onPick, onClose }: {
  label: string; projectId: string | null; excludeIds: readonly string[];
  candidateFor?: string; relation: 'parent' | 'dependency'; onPick: (task: Task) => void; onClose: () => void;
}) {
  const { tasks } = useTasks();
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [opener] = useState(() => document.activeElement);
  const result = useRelationQuery({ projectId: projectId ?? 'daily', query: search, excludeIds: [...new Set(excludeIds)].sort(),
    ...(candidateFor ? relation === 'parent' ? { parentCandidateFor: candidateFor } : { dependencyCandidateFor: candidateFor } : {}) });
  useEffect(() => {
    input.current?.focus();
    const element = input.current;
    return () => { if (!element?.isConnected && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);
  const cache = new Map(tasks.map((task) => [task.taskId, task]));
  return <div className="task-picker" role="group" aria-label={label} onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Enter' && event.target === input.current) event.preventDefault();
  }}>
    <header><label><Search /><input ref={input} aria-label={`搜索${label}`} maxLength={200} value={search} placeholder="搜索同项目任务" onChange={(event) => setSearch(event.target.value)} /></label><button type="button" className="icon-button" aria-label={`关闭${label}`} onClick={onClose}><X /></button></header>
    <div className="task-picker-results">
      {result.ids.map((id) => {
        const task = cache.get(id);
        if (!task || task.projectId !== projectId || excludeIds.includes(id)) return null;
        return <button type="button" key={id} className="task-picker-option" aria-label={`选择${label}：${task.title}（${id}）`} onClick={() => onPick(task)}><strong>{task.title}</strong><small>{taskLabel(task)} · {id}</small></button>;
      })}
    </div>
    {result.loading && <p role="status">正在读取候选任务…</p>}
    {result.error && <p role="alert">{result.error}<button type="button" className="inline-link" onClick={() => void result.reader?.refresh()}>重试候选查询</button></p>}
    {!result.loading && !result.error && !result.ids.length && <p>没有可选的同项目任务</p>}
    {result.nextOffset !== null && <button type="button" className="inline-link" disabled={result.loading} onClick={() => void result.reader?.refresh(true)}>加载更多候选任务</button>}
    <small>已读取 {result.ids.length} / {result.total} 个候选任务</small>
  </div>;
}
