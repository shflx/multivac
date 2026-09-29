import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { AssistantToolObjectRef, WorkspaceSession } from '@multivac/contracts';
import { useConfirm } from '../../components/confirm-card.js';
import { restoreNoticeText } from '../workspace/temp-retention.js';
import { useWorkspaceSessions, useWorkspaces } from '../workspace/workspace-sessions-provider.js';

/**
 * 对话中的对象链接：Multivac 回复里的 `[名称](multivac://session/<id>)`、`[名称](multivac://project/<id>)`，
 * 以及运行轨迹工具行上内部工具结果涉及的会话与项目。点开是用户操作，复用界面已有的打开方式：
 * 会话在工作区打开（切到它所在的工作区并聚焦），项目打开“设置 · 项目”并选中它。
 *
 * 对象按 id 从应用内共享的会话与工作区列表核对：核对不到（不存在、列表还没读到）时只显示文字，不给入口；
 * 已归档的会话先说明需要恢复，由用户在确认卡上选择“恢复并打开”，不自动恢复。
 */

export type ObjectLinkTarget = { kind: 'session' | 'project'; id: string };

/** 外壳提供的打开方式（与管理 · 会话页的“在工作区打开”、工作区菜单的“项目设置”同一路径）。 */
export interface ObjectLinkOpeners {
  openSession: (session: WorkspaceSession) => void | Promise<void>;
  openProject: (projectId: string) => void;
}

interface ObjectLinkContextValue {
  open: (target: ObjectLinkTarget) => Promise<void>;
}

const ObjectLinkContext = createContext<ObjectLinkContextValue | null>(null);

/** 由应用外壳挂在对话之上：提供打开会话与项目的方式；已归档会话的恢复确认在这里统一处理。 */
export function ObjectLinkProvider({ openSession, openProject, children }: ObjectLinkOpeners & { children: ReactNode }) {
  const confirm = useConfirm();
  const { sessions, restore } = useWorkspaceSessions();

  async function open(target: ObjectLinkTarget): Promise<void> {
    if (target.kind === 'project') {
      openProject(target.id);
      return;
    }
    const session = sessions?.find((candidate) => candidate.sessionId === target.id);
    if (!session) return;
    if (session.archivedAt === null) {
      await openSession(session);
      return;
    }
    // 已归档：先说明需要恢复，用户确认后才恢复；恢复失败时原因留在卡上。
    let restoredNotice: string | null = null;
    const restored = await confirm({
      title: `「${session.title}」已归档`,
      description: '需要先恢复，才能在工作区打开。',
      details: ['恢复后它回到原来的工作区，对话历史、工作目录与父子关系照旧。'],
      confirmLabel: '恢复并打开',
      action: async () => {
        restoredNotice = restoreNoticeText(session.title, await restore(session.sessionId));
      },
    });
    if (!restored) return;
    // 临时目录在归档期间已移到废纸篓：先让人看到说明，再决定是否过去。
    if (restoredNotice && !await confirm({
      title: `已恢复「${session.title}」`,
      description: restoredNotice,
      confirmLabel: '在工作区打开',
      cancelLabel: '留在这里',
    })) return;
    await openSession({ ...session, archivedAt: null });
  }

  return <ObjectLinkContext.Provider value={{ open }}>{children}</ObjectLinkContext.Provider>;
}

/**
 * 对话中打开对象的方式（与对象链接同一路径，已归档的会话先在确认卡上说明需要恢复）；
 * 不在 ObjectLinkProvider 内时为 null，调用方不给入口。
 */
export function useObjectOpener(): ((target: ObjectLinkTarget) => Promise<void>) | null {
  return useContext(ObjectLinkContext)?.open ?? null;
}

/** 按 id 从共享列表核对对象：会话（含已归档）或项目；列表还没读到或找不到时为 null。 */
function useLinkedObject(target: ObjectLinkTarget): { title: string; archived: boolean } | null {
  const { sessions, ensureLoaded } = useWorkspaceSessions();
  const { workspaces, ensureLoaded: ensureWorkspacesLoaded } = useWorkspaces();
  useEffect(() => {
    if (target.kind === 'session') void ensureLoaded().catch(() => undefined);
    else void ensureWorkspacesLoaded().catch(() => undefined);
  }, [target.kind, ensureLoaded, ensureWorkspacesLoaded]);
  if (target.kind === 'session') {
    const session = sessions?.find((candidate) => candidate.sessionId === target.id);
    return session ? { title: session.title, archived: session.archivedAt !== null } : null;
  }
  const project = workspaces?.find((candidate) => candidate.project?.projectId === target.id)?.project;
  return project ? { title: project.name, archived: false } : null;
}

/**
 * 一个对象链接。能核对到对象时是按钮（样式像链接），否则只显示文字。
 * variant：inline 用在回复正文里；chip 用在运行轨迹工具行上。
 */
export function ObjectLink({ target, children, variant = 'inline' }: {
  target: ObjectLinkTarget;
  children: ReactNode;
  variant?: 'inline' | 'chip';
}) {
  const context = useContext(ObjectLinkContext);
  const object = useLinkedObject(target);
  const className = `object-link ${variant}${object?.archived ? ' archived' : ''}`;
  if (!context || !object) return <span className={`${className} unavailable`}>{children}</span>;
  const title = target.kind === 'project'
    ? `打开设置 · 项目「${object.title}」`
    : object.archived ? `「${object.title}」已归档，恢复后才能在工作区打开` : `在工作区打开「${object.title}」`;
  return (
    <button
      type="button"
      className={className}
      data-object-kind={target.kind}
      data-object-id={target.id}
      title={title}
      onClick={() => void context.open(target)}
    >
      {children}
      {object.archived && <span className="object-link-mark">已归档</span>}
    </button>
  );
}

/** 工具行上最多直接列出的对象数；更多的只写数量（完整结果在回复正文里）。 */
export const TOOL_ROW_MAX_OBJECT_LINKS = 6;

/** 内部工具结果涉及的会话与项目（工作区不在这里给入口）：工具行上的一排可以点开的标签。 */
export function ObjectRefLinks({ refs }: { refs: readonly AssistantToolObjectRef[] }) {
  const targets = refs.flatMap((ref): Array<{ target: ObjectLinkTarget; label: string }> =>
    ref.kind === 'session' ? [{ target: { kind: 'session', id: ref.sessionId }, label: ref.label }]
      : ref.kind === 'project' ? [{ target: { kind: 'project', id: ref.projectId }, label: ref.label }] : []);
  if (targets.length === 0) return null;
  const shown = targets.slice(0, TOOL_ROW_MAX_OBJECT_LINKS);
  return (
    <div className="run-trace-refs">
      {shown.map(({ target, label }) => (
        <ObjectLink key={`${target.kind}:${target.id}`} target={target} variant="chip">{label}</ObjectLink>
      ))}
      {targets.length > shown.length && <small>等 {targets.length} 个</small>}
    </div>
  );
}
