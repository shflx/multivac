import { useTerminals } from '../terminals/terminals-provider.js';
import { railStatus, PRESET_LABELS, TerminalBadge } from '../terminals/terminal-presentation.js';
import { terminalAction } from '../../data/terminal-api.js';
import { Archive, Bell, Check, Clock3, ChevronDown, ChevronRight, Columns2, Command, Folder, FolderInput, MessageSquare, MoreHorizontal, Pencil, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type RefObject, type ReactNode, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { normalizeWorkspaceSessionTitle, terminalIsActive, TERMINAL_TITLE_MAX_LENGTH, WORKSPACE_SESSION_TITLE_MAX_LENGTH, RECENT_WORKSPACE_ID, recentSessions, type ProjectTerminal, type TerminalPreset, type Workspace, type WorkspaceSession } from '@multivac/contracts';
import { SessionStatusBadge } from '../assistant/session-status-badge.js';
import { useConfirm } from '../../components/confirm-card.js';
import { NewProjectCard } from '../projects/new-project-card.js';
import { confirmArchive } from './archive-confirm.js';
import { useWorkspaceSessions } from './workspace-sessions-provider.js';

/** 现场组件只更新导航的展示与操作，侧边栏自身由工作区外壳持续挂载。 */
export interface WorkspaceRailController {
  update(props: WorkspaceRailProps): void;
}

export interface WorkspaceRailProps {
  workspaces: readonly Workspace[];
  workspaceId: string;
  recentDays: number;
  clock: number;
  /** 并排各栏实际显示的对象：会话 id，或 `terminal:<终端 id>`。 */
  slots: readonly string[];
  currentId: string | null;
  parallelCount: number;
  onSwitch: (id: string) => void;
  onOpen: (workspaceId: string, sessionId: string) => void;
  onCreate: (workspaceId: string) => void;
  onAssign: (id: string, slot: number) => void;
  onAssignTerminal: (terminalId: string, slot: number) => void;
  onMove: (session: WorkspaceSession) => void;
  children: ReactNode;
}

/** 更新只重渲染这个宿主，避免反过来触发现场组件发布导航的循环。 */
export function WorkspaceRailHost({ controllerRef }: { controllerRef: RefObject<WorkspaceRailController | null> }) {
  const [props, setProps] = useState<WorkspaceRailProps | null>(null);
  useImperativeHandle(controllerRef, () => ({ update: setProps }), []);
  return props ? <WorkspaceRail {...props} /> : null;
}

/** 鼠标默认聚焦可能先把边缘的按钮滚入视口；在默认动作之前聚焦，避免切换时闪跳。 */
function focusWithoutScrolling(event: MouseEvent<HTMLButtonElement>) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.focus({ preventScroll: true });
}

/** 分组与会话共同标识一行；同一会话出现在多个集合时不会串改名状态。 */
export function WorkspaceRail(props: WorkspaceRailProps) {
  const terminals = useTerminals();
  const [createMenu, setCreateMenu] = useState<{ workspaceId: string; top: number; left: number; trigger: HTMLElement } | null>(null);
  const [terminalMenu, setTerminalMenu] = useState<{ terminal: ProjectTerminal; workspaceId: string; top: number; left: number; trigger: HTMLElement } | null>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const terminalMenuRef = useRef<HTMLDivElement>(null);
  const { sessions, rename, archive } = useWorkspaceSessions();
  const confirm = useConfirm();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [menu, setMenu] = useState<{ key: string; session: WorkspaceSession; top: number; left: number; trigger: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const workSessions = (sessions ?? []).filter((session) => !session.taskId);
  // 当前工作区未关闭的终端也占栏位，“放进第 k 栏”的可选栏数随之增加。
  const currentProjectId = props.workspaces.find((item) => item.workspaceId === props.workspaceId)?.project?.projectId;
  const liveTerminalCount = currentProjectId ? terminals.terminals.filter((item) => item.projectId === currentProjectId && !item.closedAt).length : 0;

  useEffect(() => { setMenu(null); setCreateMenu(null); setTerminalMenu(null); }, [props.workspaceId]);

  // 新建菜单与终端菜单：点在菜单与触发按钮之外、滚动或缩放窗口时收起。
  useEffect(() => {
    const open = createMenu ?? terminalMenu;
    if (!open) return;
    const ref = createMenu ? createMenuRef : terminalMenuRef;
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !open.trigger.contains(event.target as Node)) { setCreateMenu(null); setTerminalMenu(null); }
    };
    const close = () => { setCreateMenu(null); setTerminalMenu(null); };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    root.current?.addEventListener('scroll', close, true);
    const rail = root.current;
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', close); rail?.removeEventListener('scroll', close, true); };
  }, [createMenu, terminalMenu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menu.trigger.contains(event.target as Node)) setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    root.current?.addEventListener('scroll', close, true);
    const rail = root.current;
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', close);
      rail?.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); setEditing(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  }

  /** 菜单贴着触发按钮右侧展开，靠近窗口底部时上移。 */
  const anchored = (trigger: HTMLElement, height: number) => {
    const rect = trigger.getBoundingClientRect();
    return { top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)), left: Math.min(root.current?.getBoundingClientRect().right ?? rect.right, window.innerWidth - 260) + 4 };
  };

  function closeTerminal(terminal: ProjectTerminal, workspaceId: string) {
    const done = async () => {
      await terminalAction(terminal.terminalId, 'close', { instanceId: terminal.instanceId, confirmRunning: true });
      terminals.unplace(workspaceId, terminal.terminalId);
      if (terminals.selected?.terminalId === terminal.terminalId) terminals.select(null);
      await terminals.refresh();
    };
    if (!terminalIsActive(terminal.status)) { void run(done); return; }
    void confirm({ title: `关闭「${terminal.title}」`, description: '这会结束该终端进程及已归属的后代进程，然后关闭终端。', tone: 'danger', confirmLabel: '结束并关闭', action: done });
  }

  return <aside className="workspace-rail" aria-label="工作区会话导航" ref={root}>
    <div className="rail-scroll">
      {[...(props.recentDays ? [{ workspaceId: RECENT_WORKSPACE_ID, name: '最近', project: null }] : []), ...props.workspaces].map((workspace) => {
        const id = workspace.workspaceId;
        const current = id === props.workspaceId;
        const logical = id === RECENT_WORKSPACE_ID;
        // 任务会话只从任务详情进入独立视图，不计入工作区列表，与主区域的会话现场保持一致。
        const members = logical ? recentSessions(workSessions, props.recentDays, props.clock) : workSessions.filter((session) => session.workspaceId === id).slice().reverse();
        const live = members.filter((session) => session.archivedAt === null);
        const projectTerminals = logical ? [] : terminals.terminals.filter(item => item.projectId === workspace.project?.projectId);
        const mixed = [
          ...live.map(session => ({ type: 'session' as const, session, at: session.lastActivityAt ?? session.createdAt })),
          ...projectTerminals.filter(terminal => !terminal.closedAt).map(terminal => ({ type: 'terminal' as const, terminal, at: terminal.lastActivityAt })),
        ].sort((a, b) => b.at.localeCompare(a.at));
        const open = !collapsed.includes(id);
        return <section className="rail-group" key={id} data-workspace-id={id}>
          <div className={`rail-folder${current ? ' active' : ''}`}>
            <button type="button" className="rail-folder-toggle" onMouseDown={focusWithoutScrolling} aria-current={current ? 'true' : undefined} aria-expanded={open} onClick={() => {
              if (!current) props.onSwitch(id);
              else setCollapsed((value) => open ? [...value, id] : value.filter((item) => item !== id));
            }}>
              <span className="rail-folder-icon">{logical ? <Clock3 /> : <Folder />}<span>{open ? <ChevronDown /> : <ChevronRight />}</span></span>
              <span className="nav-label">{workspace.name}</span>{logical && <small>{props.recentDays} 天</small>}
            </button>
            {!logical && <button type="button" className="icon-button" aria-label={workspace.project && terminals.available ? `在「${workspace.name}」新建会话或终端` : `在「${workspace.name}」新建会话`} title={workspace.project && terminals.available ? '新建会话或终端' : '新建会话'} aria-haspopup={workspace.project && terminals.available ? 'menu' : undefined} aria-expanded={workspace.project && terminals.available ? createMenu?.workspaceId === id : undefined} onClick={(event) => {
              if (!workspace.project || !terminals.available) { props.onCreate(id); return; }
              const trigger = event.currentTarget;
              setCreateMenu(createMenu?.workspaceId === id ? null : { workspaceId: id, trigger, ...anchored(trigger, 300) });
            }}><Plus /></button>}
          </div>
          {open && <div className="rail-group-items">
            {mixed.map((entry) => {
              if (entry.type === 'terminal') {
                const terminal = entry.terminal;
                const key = `terminal:${terminal.terminalId}`;
                const slot = current ? props.slots.indexOf(key) : -1;
                const state = railStatus(terminal);
                return <div className={`rail-item${terminals.selected?.terminalId === terminal.terminalId ? ' selected' : ''}${terminalIsActive(terminal.status) ? '' : ' ended'}`} key={key} data-terminal-id={terminal.terminalId}>
                  {editing === key ? <form className="scene-rename" onSubmit={(event) => {
                    event.preventDefault();
                    const next = title.trim();
                    if (next) void run(async () => { await terminalAction(terminal.terminalId, 'rename', { title: next }); await terminals.refresh(); });
                  }}>
                    <input aria-label="终端名称" value={title} autoFocus maxLength={TERMINAL_TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => {
                      if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); }
                    }} />
                    <button type="submit" className="icon-button" aria-label="保存名称" disabled={busy || !title.trim()}><Check /></button>
                    <button type="button" className="icon-button" aria-label="取消改名" onClick={() => setEditing(null)}><X /></button>
                  </form> : <>
                    <button type="button" className="rail-session-open" onMouseDown={focusWithoutScrolling} title={`${terminal.title} · ${PRESET_LABELS[terminal.preset.kind]}`} onClick={() => { props.onSwitch(id); terminals.select({ workspaceId: id, terminalId: terminal.terminalId }); }}>
                      <SquareTerminal className="rail-row-icon" aria-hidden="true" /><span className="nav-label">{terminal.title}</span>
                      {terminal.notificationCount > 0 && <span className="rail-terminal-bell" title={`终端发出了 ${terminal.notificationCount} 次通知`} aria-label="终端发出了通知"><Bell /></span>}
                      {terminal.unread && !terminal.notificationCount && <span className="rail-terminal-dot" title="有新输出" aria-label="有新输出" />}
                      {state && <small className="rail-terminal-state">{state}</small>}
                      {slot >= 0 && <small className="rail-slot">{slot + 1}</small>}
                    </button>
                    <button type="button" className="icon-button rail-more" onMouseDown={focusWithoutScrolling} aria-label={`更多「${terminal.title}」`} title="更多" aria-expanded={terminalMenu?.terminal.terminalId === terminal.terminalId} onClick={(event) => {
                      const trigger = event.currentTarget;
                      setTerminalMenu(terminalMenu?.terminal.terminalId === terminal.terminalId ? null : { terminal, workspaceId: id, trigger, ...anchored(trigger, 220) });
                    }}><MoreHorizontal /></button>
                  </>}
                </div>;
              }
              const session = entry.session;
              const key = `${id}:${session.sessionId}`;
              const slot = current ? props.slots.indexOf(session.sessionId) : -1;
              return <div className={`rail-item${current && session.sessionId === props.currentId ? ' selected' : ''}`} key={key} data-session-id={session.sessionId}>
                {editing === key ? <form className="scene-rename" onSubmit={(event) => {
                  event.preventDefault();
                  const normalized = normalizeWorkspaceSessionTitle(title);
                  if (normalized) void run(() => rename(session.sessionId, normalized));
                }}>
                  <input aria-label="会话名称" value={title} autoFocus maxLength={WORKSPACE_SESSION_TITLE_MAX_LENGTH} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => {
                    if (event.key === 'Escape') { event.stopPropagation(); setEditing(null); }
                  }} />
                  <button type="submit" className="icon-button" aria-label="保存名称" disabled={busy || !normalizeWorkspaceSessionTitle(title)}><Check /></button>
                  <button type="button" className="icon-button" aria-label="取消改名" onClick={() => setEditing(null)}><X /></button>
                </form> : <>
                  <button type="button" className="rail-session-open" onMouseDown={focusWithoutScrolling} aria-label={session.title} aria-describedby={`rail-status-${id}-${session.sessionId}`} title={logical ? `${session.title} · ${props.workspaces.find((item) => item.workspaceId === session.workspaceId)?.name ?? session.workspaceId}` : session.title} onClick={() => { terminals.select(null); props.onOpen(id, session.sessionId); }}><MessageSquare className="rail-row-icon" aria-hidden="true" /><span className="nav-label">{session.title}</span><SessionStatusBadge id={`rail-status-${id}-${session.sessionId}`} sessionId={session.sessionId} />{slot >= 0 && <small className="rail-slot">{slot + 1}</small>}</button>
                  <button type="button" className="icon-button rail-more" onMouseDown={focusWithoutScrolling} aria-label={`更多「${session.title}」`} title="更多" aria-expanded={menu?.key === key} onClick={(event) => {
                    const trigger = event.currentTarget;
                    const rect = trigger.getBoundingClientRect();
                    setMenu(menu?.key === key ? null : { key, session, trigger, top: Math.max(8, Math.min(rect.top, window.innerHeight - 270)), left: Math.min(root.current?.getBoundingClientRect().right ?? rect.right, window.innerWidth - 230) + 4 });
                  }}><MoreHorizontal /></button>
                </>}
              </div>;
            })}
            {!mixed.length && <p className="rail-empty">还没有会话或终端</p>}
          </div>}
        </section>;
      })}
      <button type="button" className="rail-new-project" ref={projectTrigger} onClick={() => setCreatingProject(true)}><Plus />新建项目…</button>
      {error && <p className="workspace-error" role="alert">{error}</p>}
    </div>
    {terminals.error && <p className="rail-empty workspace-error" role="alert">{terminals.error}</p>}
    {props.children}
    {menu && createPortal(<div ref={menuRef} className="rail-menu" role="menu" aria-label={`会话操作：${menu.session.title}`} style={{ top: menu.top, left: menu.left }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.trigger.focus(); setMenu(null); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      {(menu.session.workspaceId === props.workspaceId || props.workspaceId === RECENT_WORKSPACE_ID && menu.key.startsWith(`${RECENT_WORKSPACE_ID}:`)) && Array.from({ length: Math.min(props.parallelCount, (props.workspaceId === RECENT_WORKSPACE_ID ? recentSessions(workSessions, props.recentDays, props.clock) : workSessions.filter((s) => s.workspaceId === props.workspaceId && s.archivedAt === null)).length + liveTerminalCount) }, (_, slot) => <button type="button" role="menuitem" key={slot} onClick={() => { props.onAssign(menu.session.sessionId, slot); setMenu(null); }}><Columns2 />放进第 {slot + 1} 栏</button>)}
      <button type="button" role="menuitem" autoFocus onClick={() => { setEditing(menu.key); setTitle(menu.session.title); setMenu(null); }}><Pencil />改名</button>
      <button type="button" role="menuitem" onClick={() => { menu.trigger.focus(); props.onMove(menu.session); setMenu(null); }}><FolderInput />归入项目…</button>
      <button type="button" role="menuitem" onClick={() => {
        const session = menu.session;
        const trigger = menu.trigger;
        trigger.focus();
        setMenu(null);
        void confirmArchive(confirm, { sessionId: session.sessionId, title: session.title, action: () => archive(session.sessionId), fallbackFocus: () => trigger.isConnected ? trigger : root.current?.querySelector<HTMLElement>('.rail-folder.active .rail-folder-toggle') ?? root.current?.querySelector<HTMLElement>('.rail-folder-toggle') });
      }}><Archive />归档</button>
    </div>, document.body)}
    {createMenu && createPortal(<div ref={createMenuRef} className="rail-create-menu" role="menu" aria-label="新建" style={{ top: createMenu.top, left: createMenu.left }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); createMenu.trigger.focus(); setCreateMenu(null); }
    }}>
      {(() => {
        const workspace = props.workspaces.find((item) => item.workspaceId === createMenu.workspaceId);
        if (!workspace?.project) return null;
        const project = workspace.project;
        const pick = (kind: TerminalPreset['kind']) => { setCreateMenu(null); props.onSwitch(workspace.workspaceId); terminals.create(project, kind); };
        return <>
          <button type="button" role="menuitem" autoFocus onClick={() => { setCreateMenu(null); props.onCreate(workspace.workspaceId); }}>
            <span className="rail-create-icon"><MessageSquare /></span><span><strong>会话</strong><small>由 Multivac 管控的对话与执行</small></span>
          </button>
          <hr />
          <h4>终端 · 外部程序，不受管控</h4>
          <button type="button" role="menuitem" onClick={() => pick('blank')}><TerminalBadge preset={{ kind: 'blank' }} /><span><strong>空白终端</strong><small>登录 shell</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('claude')}><TerminalBadge preset={{ kind: 'claude', argv: [] }} /><span><strong>Claude Code</strong><small>运行 claude</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('codex')}><TerminalBadge preset={{ kind: 'codex', argv: [] }} /><span><strong>Codex</strong><small>运行 codex</small></span></button>
          <button type="button" role="menuitem" onClick={() => pick('custom')}><span className="rail-create-icon"><Command /></span><span><strong>自定义命令…</strong><small>可保存为常用命令</small></span></button>
        </>;
      })()}
    </div>, document.body)}
    {terminalMenu && createPortal(<div ref={terminalMenuRef} className="rail-menu" role="menu" aria-label={`终端操作：${terminalMenu.terminal.title}`} style={{ top: terminalMenu.top, left: terminalMenu.left }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); terminalMenu.trigger.focus(); setTerminalMenu(null); }
    }}>
      {terminalMenu.workspaceId === props.workspaceId && Array.from({ length: props.parallelCount }, (_, slot) => <button type="button" role="menuitem" key={slot} onClick={() => { props.onAssignTerminal(terminalMenu.terminal.terminalId, slot); setTerminalMenu(null); }}><Columns2 />放进第 {slot + 1} 栏</button>)}
      <button type="button" role="menuitem" autoFocus onClick={() => { setEditing(`terminal:${terminalMenu.terminal.terminalId}`); setTitle(terminalMenu.terminal.title); setTerminalMenu(null); }}><Pencil />改名</button>
      <button type="button" role="menuitem" onClick={() => { const { terminal, workspaceId, trigger } = terminalMenu; trigger.focus(); setTerminalMenu(null); closeTerminal(terminal, workspaceId); }}><X />关闭终端</button>
    </div>, document.body)}
    {creatingProject && <NewProjectCard onCreated={(created) => { setCreatingProject(false); props.onSwitch(created.workspace.workspaceId); }} onCancel={() => setCreatingProject(false)} fallbackFocus={() => projectTrigger.current} />}
  </aside>;
}
