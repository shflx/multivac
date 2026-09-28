import {
  WorkspaceListResponseSchema,
  WorkspaceSceneSchema,
  WorkspaceSessionListResponseSchema,
  WorkspaceSessionSchema,
  type AssistantQuote,
  type Workspace,
  type WorkspaceListResponse,
  type WorkspaceScene,
  type WorkspaceSceneState,
  type WorkspaceSession,
  type WorkspaceSessionListResponse,
} from '@multivac/contracts';
import { fetchJson } from './assistant-api.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

function sessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

/** 全部工作区：项目工作区（带项目与目录）在前，默认工作区在最后。 */
export async function listWorkspaces(): Promise<Workspace[]> {
  return (await fetchJson<WorkspaceListResponse>('/api/workspaces', undefined, WorkspaceListResponseSchema)).workspaces;
}

/**
 * 列出工作会话，按创建时间升序：缺省为默认工作区，allWorkspaces 时跨全部工作区；
 * includeArchived 时一并返回已归档会话（archivedAt 非空）。
 */
export function listWorkspaceSessions(
  options: { includeArchived?: boolean; allWorkspaces?: boolean } = {},
): Promise<WorkspaceSessionListResponse> {
  const query = new URLSearchParams();
  if (options.allWorkspaces) query.set('workspace', 'all');
  if (options.includeArchived) query.set('archived', 'include');
  const search = query.toString();
  return fetchJson(`/api/sessions${search ? `?${search}` : ''}`, undefined, WorkspaceSessionListResponseSchema);
}

/**
 * sessionId 由调用方生成并作为幂等键；网络重试使用同一 id 不会重复新建。
 * workspaceId 为新会话所在的工作区（项目工作区中的会话使用项目目录）；
 * 带 parent 时为栈式深入：基于父会话中选中的内容新建子会话，子会话留在父会话的工作区。
 */
export function createWorkspaceSession(
  sessionId: string,
  title: string,
  options: { workspaceId?: string; parent?: { sessionId: string; quote: AssistantQuote } } = {},
): Promise<WorkspaceSession> {
  return fetchJson('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, title, ...options }),
  }, WorkspaceSessionSchema);
}

export function renameWorkspaceSession(sessionId: string, title: string): Promise<WorkspaceSession> {
  return fetchJson(sessionPath(sessionId), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  }, WorkspaceSessionSchema);
}

export function archiveWorkspaceSession(sessionId: string): Promise<WorkspaceSession> {
  return fetchJson(`${sessionPath(sessionId)}/archive`, { method: 'POST' }, WorkspaceSessionSchema);
}

/** 恢复已归档的会话：回到原工作区，重复恢复返回同一结果。 */
export function restoreWorkspaceSession(sessionId: string): Promise<WorkspaceSession> {
  return fetchJson(`${sessionPath(sessionId)}/restore`, { method: 'POST' }, WorkspaceSessionSchema);
}

export function getWorkspaceScene(workspaceId: string): Promise<WorkspaceScene> {
  return fetchJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/scene`, undefined, WorkspaceSceneSchema);
}

/** keepalive 用于页面离开时的最后一次保存。 */
export function putWorkspaceScene(
  workspaceId: string,
  scene: WorkspaceSceneState,
  keepalive = false,
): Promise<WorkspaceScene> {
  return fetchJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/scene`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(scene),
    keepalive,
  }, WorkspaceSceneSchema);
}
