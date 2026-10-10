import { MessageSquare, Search, X, ListTodo, type LucideIcon } from 'lucide-react';
import { useTasks } from '../features/tasks/tasks-provider.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceSessions, useWorkspaces } from '../features/workspace/workspace-sessions-provider.js';
import { SessionStatusBadge } from '../features/assistant/session-status-badge.js';
import type { WorkspaceViewReport } from '../features/assistant/current-view.js';
import { focusableWithin, wrapFocusIndex } from '../components/focus-trap.js';
import { MANAGEMENT_NAV, type ManagementPageId } from './management-nav.js';
import { CommandPalette, PaletteFooter } from './command-palette.js';
import { recentJumpItems, searchJumpItems } from './jump-search.js';

interface JumpItem {
  id: string; label: string; hint: string; detail: string; group: string; groupId: string; current: boolean; activity?: number;
  icon: LucideIcon; keywords?: readonly string[]; sessionId?: string; run: () => void;
}
const PAGE_KEYWORDS: Record<ManagementPageId, string[]> = {
  reading: ['书架', '书伴', '读书', 'reading'],
  inbox: ['请求', '授权', '澄清', '验收', '恢复'],
  runs: ['运行', '执行', '进程', 'runs'],
  tasks: ['任务', '待办', '看板', '列表', 'task', 'todo'],
  archive: ['归档', '恢复', '会话'], projects: ['目录', '项目'], models: ['API Key', '模型', '协议', '推理'], preferences: ['最近', '偏好', '临时目录'],
};

export function QuickSwitcher({ management, page, view, onSession, onPage, onClose, onTask }: {
  management: boolean; page: ManagementPageId; view: WorkspaceViewReport | null;
  onSession: (workspaceId: string, sessionId: string) => void; onPage: (id: ManagementPageId) => void; onClose: () => void;
  onTask?: (id: string) => void;
}) {
  const { tasks, store, selected } = useTasks();
  useEffect(() => { store?.ensure(); }, [store]);
  const { sessions, ensureLoaded } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: loadWorkspaces } = useWorkspaces();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!management) Promise.all([ensureLoaded(), loadWorkspaces()]).catch((cause) => setLoadError(cause instanceof Error ? cause.message : '会话读取失败。'));
  }, [management, ensureLoaded, loadWorkspaces]);
  const groups = [...(workspaces ?? [])].sort((a, b) => Number(b.workspaceId === view?.workspaceId) - Number(a.workspaceId === view?.workspaceId));
  const items: JumpItem[] = management ? MANAGEMENT_NAV.flatMap((group) => group.pages.map((item) => ({
    id: item.id, label: item.label, hint: group.label, detail: group.label, group: group.label, groupId: group.id, icon: item.icon,
    current: page === item.id, keywords: PAGE_KEYWORDS[item.id], run: () => onPage(item.id),
  }))) : groups.flatMap((group) => (sessions ?? []).filter((session) => session.workspaceId === group.workspaceId && session.archivedAt === null).slice().reverse().map((session) => {
    const slot = view?.scene?.slots.indexOf(session.sessionId) ?? -1;
    return {
      id: session.sessionId, sessionId: session.sessionId, label: session.title, hint: `${group.name} · ${session.taskId ? '任务会话' : '工作会话'}`,
      detail: slot >= 0 ? `第 ${slot + 1} 栏` : '', group: group.name, groupId: group.workspaceId, icon: MessageSquare,
      activity: Date.parse(session.lastActivityAt ?? session.createdAt),
      current: view?.scene?.focusedSessionId === session.sessionId, keywords: [session.taskId ? '任务会话' : '工作会话', group.name],
      run: () => onSession(session.workspaceId, session.sessionId),
    };
  }));
  const taskItems: JumpItem[] = onTask ? tasks.map((task) => ({ id: `task:${task.taskId}`, label: task.title, hint: '任务', detail: task.reason, group: '任务', groupId: 'tasks', current: management && page === 'tasks' && selected === task.taskId, icon: ListTodo, keywords: ['任务', task.goal], run: () => onTask(task.taskId) })) : [];
  return <QuickPalette items={[...items, ...taskItems]} recent={management ? [] : recentJumpItems(items)} title={management ? '跳到页面' : '跳到会话'} scope={management ? '管理' : '工作区'} error={loadError} onClose={onClose} />;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const term = query.trim().split(/\s+/u)[0] ?? '';
  const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
  return at < 0 ? text : <>{text.slice(0, at)}<mark>{text.slice(at, at + term.length)}</mark>{text.slice(at + term.length)}</>;
}

function QuickPalette({ items, recent, title, scope, error, onClose }: { items: JumpItem[]; recent: JumpItem[]; title: string; scope: string; error: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [previousFocus] = useState(() => document.activeElement);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const recentIds = new Set(recent.map((item) => item.id));
  const shown = query.trim() ? searchJumpItems(items, query) : [
    ...recent.map((item) => ({ ...item, group: '最近会话', groupId: 'quick-recent', detail: [item.hint, item.detail].filter(Boolean).join(' · ') })),
    ...items.filter((item) => !recentIds.has(item.id)),
  ];
  const index = Math.max(0, shown.findIndex((item) => item.id === selected));
  function restoreFocus() { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); }
  function close() { restoreFocus(); onClose(); }
  function pick(item: JumpItem) { close(); item.run(); }
  useLayoutEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index, query]);

  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (event) => {
    event.stopPropagation();
    if (!dialogRef.current?.contains(document.activeElement)) inputRef.current?.focus();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) setSelected(shown[(index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length]!.id);
    } else if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); if (shown[index]) pick(shown[index]!);
    } else if (event.key === 'Tab' && dialogRef.current) {
      const focusable = focusableWithin(dialogRef.current);
      const next = wrapFocusIndex(focusable.length, focusable.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (next !== null) { event.preventDefault(); focusable[next]?.focus(); }
    } else if ((event.metaKey || event.ctrlKey) && ['g', 'j', 'b', 'k'].includes(event.key.toLowerCase())) event.preventDefault();
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => keyRef.current(event);
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, []);
  return <CommandPalette title={title} onClose={close} dialogRef={dialogRef}>
    <div className="palette-search"><Search aria-hidden="true" /><input ref={inputRef} role="combobox" aria-label={`搜索${scope === '管理' ? '页面' : '会话'}`} aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[index] ? `${listId}-${shown[index]!.id}` : undefined} placeholder={`搜索${scope === '管理' ? '页面' : '会话'}`} value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); }} />
      {query && <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => { setQuery(''); setSelected(null); inputRef.current?.focus(); }}><X /></button>}<span className="palette-scope">{scope}</span>
    </div>
    {shown.length ? <ul className="palette-list" ref={listRef} id={listId} role="listbox" aria-label={title}>
      {shown.map((item, position) => {
        const Icon = item.icon;
        return <li key={item.id} role="presentation">
          {!query.trim() && item.groupId !== shown[position - 1]?.groupId && <div className="palette-group"><span>{item.group}</span><span>{shown.filter((entry) => entry.groupId === item.groupId).length}</span></div>}
          <button type="button" role="option" id={`${listId}-${item.id}`} className={`palette-item${position === index ? ' selected' : ''}`} aria-selected={position === index} onMouseEnter={() => setSelected(item.id)} onClick={() => pick(item)}>
            <span className="palette-icon"><Icon /></span><span className="palette-text"><strong><Highlight text={item.label} query={query} /></strong><small><Highlight text={query.trim() ? item.hint : item.detail} query={query} /></small></span>
            <span className="palette-meta">{item.sessionId && <SessionStatusBadge sessionId={item.sessionId} />}{item.current && <em className="palette-pill">当前</em>}{position === index && <kbd>↵</kbd>}</span>
          </button>
        </li>;
      })}
    </ul> : <div className="palette-empty"><Search /><strong>{error || (query.trim() ? `没有匹配“${query.trim()}”的结果` : '暂无可跳转会话')}</strong></div>}
    <PaletteFooter />
  </CommandPalette>;
}
