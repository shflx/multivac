import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CreateWorkspaceSessionSchema,
  RenameWorkspaceSessionSchema,
  WorkspaceSceneStateSchema,
  WORKSPACE_SESSION_BODY_LIMIT_BYTES,
  type AssistantApiErrorCode,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  WorkspaceSessionService,
  WorkspaceSessionServiceError,
} from '../../application/workspace-session-service.js';
import { AssistantSessionServiceError } from '../../application/assistant-session-service.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

function errorStatus(code: AssistantApiErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_ID_CONFLICT':
      return 409;
    case 'COMMAND_STATE_MISMATCH':
      return 422;
    case 'ASSISTANT_SESSION_BINDING_MISMATCH':
    case 'ASSISTANT_SESSION_RECOVERY_FAILED':
    case 'ASSISTANT_SESSION_UNAVAILABLE':
    case 'DEFAULT_MODEL_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > WORKSPACE_SESSION_BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

function isJson(request: IncomingMessage): boolean {
  return Boolean(request.headers['content-type']?.toLowerCase().startsWith('application/json'));
}

/** 解析 `/api/sessions/:id` 与 `/api/sessions/:id/archive`；id 需 URL 解码。 */
function sessionPath(pathname: string): { sessionId: string; action: 'archive' | null } | null {
  const match = /^\/api\/sessions\/([^/]+)(\/archive)?$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return { sessionId: decodeURIComponent(match[1]), action: match[2] ? 'archive' : null };
  } catch {
    return null;
  }
}

/** 解析 `/api/workspaces/:id/scene`。 */
function scenePath(pathname: string): string | null {
  const match = /^\/api\/workspaces\/([^/]+)\/scene$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** 工作区接口：会话注册表（列出、新建、改名与归档）与工作区现场。 */
export function createWorkspaceSessionRequestHandler(service: WorkspaceSessionService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const collection = url.pathname === '/api/sessions';
    const item = collection ? null : sessionPath(url.pathname);
    const sceneWorkspaceId = scenePath(url.pathname);
    if (!collection && !item && sceneWorkspaceId === null) return false;

    try {
      if (sceneWorkspaceId !== null && request.method === 'GET') {
        writeJson(response, 200, service.getScene(sceneWorkspaceId));
        return true;
      }
      if (sceneWorkspaceId !== null && request.method === 'PUT') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '工作区现场必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(WorkspaceSceneStateSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '工作区现场请求体无效。');
          return true;
        }
        writeJson(response, 200, service.saveScene(sceneWorkspaceId, body));
        return true;
      }
      if (sceneWorkspaceId !== null) {
        writeError(response, 405, 'INVALID_REQUEST', '不支持的请求方法。');
        return true;
      }
      if (collection && request.method === 'GET') {
        writeJson(response, 200, service.list());
        return true;
      }
      if (collection && request.method === 'POST') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '新建会话必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(CreateWorkspaceSessionSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '新建会话请求体无效。');
          return true;
        }
        const result = await service.create(body);
        writeJson(response, result.created ? 201 : 200, result.session);
        return true;
      }
      if (item && item.action === null && request.method === 'PATCH') {
        if (!isJson(request)) {
          writeError(response, 415, 'INVALID_REQUEST', '会话改名必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (!Check(RenameWorkspaceSessionSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '会话改名请求体无效。');
          return true;
        }
        writeJson(response, 200, service.rename(item.sessionId, body.title));
        return true;
      }
      if (item && item.action === 'archive' && request.method === 'POST') {
        writeJson(response, 200, service.archive(item.sessionId));
        return true;
      }
      // 其余 `/api/sessions/:id/...` 路径由会话级接口处理。
      return false;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      } else if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      } else if (error instanceof WorkspaceSessionServiceError || error instanceof AssistantSessionServiceError) {
        writeError(response, errorStatus(error.code), error.code, error.message);
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
      return true;
    }
  };
}
