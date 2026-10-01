import { Archive, Check, Clock3, ChevronDown, ChevronRight, Columns2, Folder, FolderInput, MoreHorizontal, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { normalizeWorkspaceSessionTitle, WORKSPACE_SESSION_TITLE_MAX_LENGTH, RECENT_WORKSPACE_ID, recentSessions, type Workspace, type WorkspaceSession } from '@multivac/contracts';
import { useAssistantSession } from '../assistant/assistant-session.js';
import { useConfirm } from '../../components/confirm-card.js';
import { NewProjectCard } from '../projects/new-project-card.js';
import { confirmArchive } from './archive-confirm.js';
import { useWorkspaceSessions } from './workspace-sessions-provider.js';

interface RailProps {
  workspaces: readonly Workspace[];
  workspaceId: string;
  recentDays: number;
  clock: number;
  slots: readonly string[];
  currentId: string | null;
  parallelCount: number;
  onSwitch: (id: string) => void;
  onOpen: (workspaceId: string, sessionId: string) => void;
  onCreate: (workspaceId: string) => void;
  onAssign: (id: string, slot: number) => void;
  onMove: (session: WorkspaceSession) => void;
  onRestore: (id: string) => Promise<void>;
  children: ReactNode;
}

/** 分组与会话共同标识一行；同一会话出现在多个集合时不会串改名状态。 */
export function WorkspaceRail(props: RailProps) {
  const { sessions, rename, archive } = useWorkspaceSessions();
  const confirm = useConfirm();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [menu, setMenu] = useState<{ key: string; session: WorkspaceSession; top: number; left: number; trigger: HTMLElement } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);

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

  return <aside className="workspace-rail" aria-label="工作区会话导航" ref={root}>
    <div className="rail-scroll">
      {[...(props.recentDays ? [{ workspaceId: RECENT_WORKSPACE_ID, name: '最近', project: null }] : []), ...props.workspaces].map((workspace) => {
        const id = workspace.workspaceId;
        const current = id === props.workspaceId;
        const logical = id === RECENT_WORKSPACE_ID;
        const members = logical ? recentSessions(sessions ?? [], props.recentDays, props.clock) : (sessions ?? []).filter((session) => session.workspaceId === id).slice().reverse();
        const live = members.filter((session) => session.archivedAt === null);
        const archived = members.filter((session) => session.archivedAt !== null);
        const open = !collapsed.includes(id);
        return <section className="rail-group" key={id} data-workspace-id={id}>
          <div className={`rail-folder${current ? ' active' : ''}`}>
            <button type="button" className="rail-folder-toggle" aria-current={current ? 'true' : undefined} aria-expanded={open} onClick={() => {
              if (!current) props.onSwitch(id);
              else setCollapsed((value) => open ? [...value, id] : value.filter((item) => item !== id));
            }}>
              <span className="rail-folder-icon">{logical ? <Clock3 /> : <Folder />}<span>{open ? <ChevronDown /> : <ChevronRight />}</span></span>
              <span className="nav-label">{workspace.name}</span>{logical && <small>{props.recentDays} 天</small>}
            </button>
            {!logical && <button type="button" className="icon-button" aria-label={`在「${workspace.name}」新建会话`} title="新建会话" onClick={() => props.onCreate(id)}><Plus /></button>}
          </div>
          {open && <div className="rail-group-items">
            {live.map((session) => {
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
                  <button type="button" className="rail-session-open" aria-label={session.title} title={logical ? `${session.title} · ${props.workspaces.find((item) => item.workspaceId === session.workspaceId)?.name ?? session.workspaceId}` : session.title} onClick={() => props.onOpen(id, session.sessionId)}><span className="nav-label">{session.title}</span><SessionAttention sessionId={session.sessionId} />{slot >= 0 && <small className="rail-slot">{slot + 1}</small>}</button>
                  <button type="button" className="icon-button rail-more" aria-label={`更多「${session.title}」`} title="更多" aria-expanded={menu?.key === key} onClick={(event) => {
                    const trigger = event.currentTarget;
                    const rect = trigger.getBoundingClientRect();
                    setMenu(menu?.key === key ? null : { key, session, trigger, top: Math.max(8, Math.min(rect.top, window.innerHeight - 270)), left: Math.min(root.current?.getBoundingClientRect().right ?? rect.right, window.innerWidth - 230) + 4 });
                  }}><MoreHorizontal /></button>
                </>}
              </div>;
            })}
            {!live.length && <p className="rail-empty">还没有会话</p>}
            {current && archived.length > 0 && <>
              <button type="button" className="rail-archived-toggle" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>已归档 {archived.length}{showArchived ? <ChevronDown /> : <ChevronRight />}</button>
              {showArchived && archived.map((session) => <div className="rail-archived-item" key={session.sessionId}><span className="nav-label">{session.title}</span><button type="button" className="text-button" disabled={busy} aria-label={`恢复「${session.title}」`} onClick={() => void run(() => props.onRestore(session.sessionId))}>恢复</button></div>)}
            </>}
          </div>}
        </section>;
      })}
      <button type="button" className="rail-new-project" ref={projectTrigger} onClick={() => setCreatingProject(true)}><Plus />新建项目…</button>
      {error && <p className="workspace-error" role="alert">{error}</p>}
    </div>
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
      {(menu.session.workspaceId === props.workspaceId || props.workspaceId === RECENT_WORKSPACE_ID && menu.key.startsWith(`${RECENT_WORKSPACE_ID}:`)) && Array.from({ length: Math.min(props.parallelCount, (props.workspaceId === RECENT_WORKSPACE_ID ? recentSessions(sessions ?? [], props.recentDays, props.clock) : (sessions ?? []).filter((s) => s.workspaceId === props.workspaceId && s.archivedAt === null)).length) }, (_, slot) => <button type="button" role="menuitem" key={slot} onClick={() => { props.onAssign(menu.session.sessionId, slot); setMenu(null); }}><Columns2 />放进第 {slot + 1} 栏</button>)}
      <button type="button" role="menuitem" autoFocus onClick={() => { setEditing(menu.key); setTitle(menu.session.title); setMenu(null); }}><Pencil />改名</button>
      <button type="button" role="menuitem" onClick={() => { menu.trigger.focus(); props.onMove(menu.session); setMenu(null); }}><FolderInput />归入项目…</button>
      <button type="button" role="menuitem" onClick={() => {
        const session = menu.session;
        const trigger = menu.trigger;
        trigger.focus();
        setMenu(null);
        void confirmArchive(confirm, { sessionId: session.sessionId, title: session.title, action: () => archive(session.sessionId), fallbackFocus: () => trigger.isConnected ? trigger : root.current?.querySelector<HTMLElement>('.rail-archived-toggle') ?? root.current?.querySelector<HTMLElement>('.rail-folder-toggle') });
      }}><Archive />归档</button>
    </div>, document.body)}
    {creatingProject && <NewProjectCard onCreated={(created) => { setCreatingProject(false); props.onSwitch(created.workspace.workspaceId); }} onCancel={() => setCreatingProject(false)} fallbackFocus={() => projectTrigger.current} />}
  </aside>;
}

export function SessionAttention({ sessionId }: { sessionId: string }) {
  const entry = useAssistantSession(sessionId);
  return entry?.session.runFeedback.phase === 'authorization' ? <span className="rail-attention" title="等你处理" aria-label="等你处理" /> : null;
}
