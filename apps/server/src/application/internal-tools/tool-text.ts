import {
  multivacObjectLink,
  INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH,
  INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH,
  type AssistantToolObjectRef,
  type Project,
  type WorkingDirectoryKind,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import { InternalToolError } from '../../modules/internal-tools/internal-tool.js';
import { WorkspaceSessionServiceError } from '../workspace-session-service.js';
import type { InternalToolServices } from './internal-tool-service.js';

/**
 * 内部工具共用的写法：正文里的对象链接、公开结果中的对象引用与摘要，以及按 id 读取会话时的中文原因。
 * 查询类与管理类工具都用这里的写法，模型看到的口径一致。
 */

/** 工作目录类型的称呼（与界面的规则文案同一口径）。 */
export const WORKING_DIRECTORY_LABELS: Readonly<Record<WorkingDirectoryKind, string>> = {
  'session-temp': '会话临时目录',
  multivac: 'Multivac 工作目录',
  'project-managed': '项目托管目录',
  'project-mounted': '项目挂载目录',
  worktree: 'worktree',
  'task-isolated': '任务独立目录',
};

export function clip(text: string, limit: number): string {
  const normalized = text.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

/** 工具行上的结果摘要：截到公开结果允许的长度以内。 */
export function summaryOf(text: string): string {
  return clip(text, INTERNAL_TOOL_RESULT_SUMMARY_MAX_LENGTH - 1);
}

/** 回执的一句补充：各部分以分号连接，截到回执允许的长度以内；空的部分略去。 */
export function detailOf(parts: ReadonlyArray<string | null>): string {
  return clip(parts.filter(Boolean).join('；'), INTERNAL_TOOL_RECEIPT_DETAIL_MAX_LENGTH - 1);
}

export function workspaceById(services: InternalToolServices, workspaceId: string): Workspace | undefined {
  return services.projects.listWorkspaces().workspaces.find((workspace) => workspace.workspaceId === workspaceId);
}

/** Markdown 链接文字中的方括号与反斜杠需要转义，否则标题会打断链接。 */
function linkText(text: string): string {
  return text.replace(/[\\[\]]/gu, (character) => `\\${character}`);
}

/** 正文中的会话链接 `[标题](multivac://session/<id>)`：模型照抄进回复即可在界面上点开。 */
export function sessionLink(session: Pick<WorkspaceSession, 'sessionId' | 'title'>): string {
  return `[${linkText(session.title)}](${multivacObjectLink('session', session.sessionId)})`;
}

export function projectLink(project: Pick<Project, 'projectId' | 'name'>): string {
  return `[${linkText(project.name)}](${multivacObjectLink('project', project.projectId)})`;
}

/** 正文中的工作区链接 `[名称](multivac://workspace/<id>)`：界面上点开即切到这个工作区。 */
export function workspaceLink(workspace: Pick<Workspace, 'workspaceId' | 'name'>): string {
  return `[${linkText(workspace.name)}](${multivacObjectLink('workspace', workspace.workspaceId)})`;
}

export function workspaceRef(workspace: Pick<Workspace, 'workspaceId' | 'name'>): AssistantToolObjectRef {
  return { kind: 'workspace', workspaceId: workspace.workspaceId, label: workspace.name };
}

export function sessionRef(session: Pick<WorkspaceSession, 'sessionId' | 'title'>): AssistantToolObjectRef {
  return { kind: 'session', sessionId: session.sessionId, label: session.title };
}

export function projectRef(project: Pick<Project, 'projectId' | 'name'>): AssistantToolObjectRef {
  return { kind: 'project', projectId: project.projectId, label: project.name };
}

/**
 * 按 id 读取一个工作会话（含已归档）：把服务的中文错误转成模型可读、说明接下来怎么做的原因。
 * action 写成“没有<action>”的动作，如“查看会话”“归档会话”。
 */
export function requireSession(services: InternalToolServices, sessionId: string, action: string): WorkspaceSession {
  try {
    return services.sessions.get(sessionId);
  } catch (error) {
    if (error instanceof WorkspaceSessionServiceError && error.code === 'NOT_FOUND') {
      throw new InternalToolError(`没有${action}：没有 id 为 ${sessionId} 的会话。可以先用 list_sessions 按名称查找会话 id。`);
    }
    if (error instanceof WorkspaceSessionServiceError) {
      throw new InternalToolError(`没有${action}：${error.message}这个工具只用于工作会话，你自己的对话已经在上下文中。`);
    }
    throw error;
  }
}
