import {
  WorkspaceSceneSchema,
  WorkspaceSessionListResponseSchema,
  WorkspaceSessionSchema,
  type AssistantQuote,
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

export function listWorkspaceSessions(): Promise<WorkspaceSessionListResponse> {
  return fetchJson('/api/sessions', undefined, WorkspaceSessionListResponseSchema);
}

/**
 * sessionId 由调用方生成并作为幂等键；网络重试使用同一 id 不会重复新建。
 * 带 parent 时为栈式深入：基于父会话中选中的内容新建子会话。
 */
export function createWorkspaceSession(
  sessionId: string,
  title: string,
  parent?: { sessionId: string; quote: AssistantQuote },
): Promise<WorkspaceSession> {
  return fetchJson('/api/sessions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ sessionId, title, ...(parent ? { parent } : {}) }),
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
