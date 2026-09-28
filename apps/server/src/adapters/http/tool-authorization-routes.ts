import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DecideToolAuthorizationSchema,
  GLOBAL_ASSISTANT_SESSION_ID,
  type AssistantApiErrorCode,
  type ToolAuthorizationDecisionResponse,
  type ToolAuthorizationListResponse,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  ToolAuthorizationService,
  ToolAuthorizationServiceError,
} from '../../application/tool-authorization-service.js';
import { WorkspaceSessionServiceError } from '../../application/workspace-session-service.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const DECISION_BODY_LIMIT_BYTES = 1024;

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > DECISION_BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

/**
 * 解析授权接口路径：`/api/assistant/authorizations[/:requestId/decision]` 属于全局 Multivac，
 * `/api/sessions/:id/authorizations[/:requestId/decision]` 属于对应会话；id 需 URL 解码。
 */
function authorizationRoute(pathname: string): { sessionId: string; requestId: string | null } | null {
  const match = /^\/api\/(?:assistant|sessions\/([^/]+))\/authorizations(?:\/([^/]+)\/decision)?$/u.exec(pathname);
  if (!match) return null;
  if (pathname.startsWith('/api/sessions/') && !match[1]) return null;
  try {
    return {
      sessionId: match[1] ? decodeURIComponent(match[1]) : GLOBAL_ASSISTANT_SESSION_ID,
      requestId: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    return null;
  }
}

export interface ToolAuthorizationRoutesOptions {
  service: ToolAuthorizationService;
  /** 确认会话存在且未归档；不存在时抛出 NOT_FOUND。 */
  requireSession: (sessionId: string) => void;
}

/**
 * 授权请求的查询与决定。决定只能由用户经界面或接口提交：它不是 Agent 可调用的工具，
 * 引用、消息与工具返回内容都不会触发它。
 */
export function createToolAuthorizationRequestHandler(options: ToolAuthorizationRoutesOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = authorizationRoute(url.pathname);
    if (!route) return false;

    try {
      if (route.requestId === null) {
        if (request.method !== 'GET') {
          writeError(response, 404, 'NOT_FOUND', '接口不存在。');
          return true;
        }
        if ([...url.searchParams.keys()].length > 0) {
          writeError(response, 400, 'INVALID_REQUEST', '授权请求列表不接受查询参数。');
          return true;
        }
        options.requireSession(route.sessionId);
        const body: ToolAuthorizationListResponse = {
          sessionId: route.sessionId,
          requests: options.service.list(route.sessionId),
        };
        writeJson(response, 200, body);
        return true;
      }

      if (request.method !== 'POST') {
        writeError(response, 404, 'NOT_FOUND', '接口不存在。');
        return true;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        writeError(response, 415, 'INVALID_REQUEST', '授权决定必须使用 application/json。');
        return true;
      }
      const body = await readJsonBody(request);
      if (!Check(DecideToolAuthorizationSchema, body)) {
        writeError(response, 400, 'INVALID_REQUEST', '授权决定无效。');
        return true;
      }
      options.requireSession(route.sessionId);
      const result: ToolAuthorizationDecisionResponse = {
        request: options.service.decide(route.sessionId, route.requestId, body.decision),
      };
      writeJson(response, 200, result);
      return true;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      } else if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      } else if (error instanceof ToolAuthorizationServiceError) {
        writeError(response, error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message);
      } else if (error instanceof WorkspaceSessionServiceError && error.code === 'NOT_FOUND') {
        writeError(response, 404, 'NOT_FOUND', error.message);
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
      return true;
    }
  };
}
