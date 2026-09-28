import {
  GLOBAL_ASSISTANT_SESSION_ID,
  type ToolAuthorizationGrant,
  type ToolAuthorizationRequest,
  type Workspace,
  type WorkspaceSession,
} from '@multivac/contracts';
import {
  AUTHORIZATION_OUTCOMES,
  AUTHORIZATION_TOOL_ACTIONS,
  approvalLabel,
} from '../assistant/tool-authorizations.js';

/** 授权记录页上的时间：月/日 时:分（本地时间），与原型一致；无法解析时原样返回。 */
export function recordTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** 会话的称呼：全局 Multivac、会话「名称」（已归档时注明），名称尚未读到时只写“会话”。 */
export function sessionLabel(sessionId: string, sessions: readonly WorkspaceSession[] | null): string {
  if (sessionId === GLOBAL_ASSISTANT_SESSION_ID) return '全局 Multivac';
  const session = sessions?.find((item) => item.sessionId === sessionId);
  if (!session) return '会话';
  return session.archivedAt ? `会话「${session.title}」（已归档）` : `会话「${session.title}」`;
}

/** 项目的称呼：项目「名称」，名称尚未读到时只写“项目”。 */
export function projectLabel(projectId: string, workspaces: readonly Workspace[] | null): string {
  const name = workspaces?.find((workspace) => workspace.project?.projectId === projectId)?.project?.name;
  return name ? `项目「${name}」` : '项目';
}

/** 记住的授权的范围与归属：“本会话内允许 · 会话「名称」”或“本项目内始终允许 · 项目「名称」”。 */
export function grantOwnerText(
  grant: ToolAuthorizationGrant,
  sessions: readonly WorkspaceSession[] | null,
  workspaces: readonly Workspace[] | null,
): string {
  return grant.scope === 'session'
    ? `本会话内允许 · ${sessionLabel(grant.sessionId!, sessions)}`
    : `本项目内始终允许 · ${projectLabel(grant.projectId!, workspaces)}`;
}

/** 授权记录的使用情况：还没有用过，或最近一次使用的时间与次数。 */
export function grantUsageText(grant: ToolAuthorizationGrant): string {
  return grant.lastUsedAt ? `最近使用 ${recordTime(grant.lastUsedAt)}（共 ${grant.useCount} 次）` : '还没有用过';
}

/** 最近的授权请求：操作与目标路径。 */
export function requestOperationText(request: ToolAuthorizationRequest): string {
  return `${AUTHORIZATION_TOOL_ACTIONS[request.toolName]} ${request.targetPath}`;
}

/** 最近的授权请求的结果：待授权、批准依据（范围与来源）或未获批准的原因。 */
export function requestOutcomeText(request: ToolAuthorizationRequest): string {
  if (request.status === 'pending') return '待授权';
  if (request.status === 'approved') {
    return approvalLabel(request.approval ?? { scope: 'once', source: 'user', grantId: null });
  }
  return AUTHORIZATION_OUTCOMES[request.status].short;
}
