import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  ASSISTANT_PAGE_STATE_BODY_LIMIT_BYTES,
  AssistantPageStatePutSchema,
  AssistantSessionQuerySchema,
  type AssistantApiErrorCode,
  type AssistantApiErrorResponse,
  type AssistantSessionQuery,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  AssistantSessionService,
  AssistantSessionServiceError,
} from '../../application/assistant-session-service.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(
  response: ServerResponse,
  status: number,
  code: AssistantApiErrorCode,
  message: string,
): void {
  const body: AssistantApiErrorResponse = { error: { code, message } };
  writeJson(response, status, body);
}

function serviceErrorStatus(code: AssistantApiErrorCode): number {
  switch (code) {
    case 'INVALID_CURSOR':
    case 'INVALID_REQUEST':
      return 400;
    case 'PAGE_STATE_CONFLICT':
      return 409;
    case 'ASSISTANT_SESSION_BINDING_MISMATCH':
    case 'ASSISTANT_SESSION_RECOVERY_FAILED':
    case 'ASSISTANT_SESSION_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

function parseSessionQuery(url: URL): AssistantSessionQuery | undefined {
  const allowed = new Set(['before', 'limit']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    return undefined;
  }
  const before = url.searchParams.get('before');
  const limitValue = url.searchParams.get('limit');
  if (url.searchParams.getAll('before').length > 1 || url.searchParams.getAll('limit').length > 1) {
    return undefined;
  }
  if (before !== null && before.length === 0) {
    return undefined;
  }
  if (limitValue !== null && !/^\d+$/u.test(limitValue)) {
    return undefined;
  }

  const query = {
    ...(before === null ? {} : { before }),
    ...(limitValue === null ? {} : { limit: Number(limitValue) }),
  };
  return Check(AssistantSessionQuerySchema, query) ? query : undefined;
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    throw new SyntaxError('empty body');
  }
  return JSON.parse(text);
}

export interface AssistantRoutesOptions {
  service: AssistantSessionService;
  bodyLimitBytes?: number;
}

export function createAssistantRequestHandler(options: AssistantRoutesOptions) {
  const bodyLimitBytes = options.bodyLimitBytes ?? ASSISTANT_PAGE_STATE_BODY_LIMIT_BYTES;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/assistant/session') {
        const query = parseSessionQuery(url);
        if (!query) {
          writeError(response, 400, 'INVALID_REQUEST', '会话分页参数无效。');
          return;
        }
        writeJson(response, 200, await options.service.getSessionPage(query));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/assistant/page-state') {
        writeJson(response, 200, await options.service.getPageState());
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/api/assistant/page-state') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          writeError(response, 415, 'INVALID_REQUEST', '页面状态请求必须使用 application/json。');
          return;
        }
        const body = await readJsonBody(request, bodyLimitBytes);
        if (
          typeof body === 'object' &&
          body !== null &&
          'draft' in body &&
          typeof body.draft === 'string' &&
          Buffer.byteLength(body.draft, 'utf8') > ASSISTANT_DRAFT_MAX_UTF8_BYTES
        ) {
          writeError(response, 413, 'BODY_TOO_LARGE', '草稿超过可保存的大小限制。');
          return;
        }
        if (!Check(AssistantPageStatePutSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '页面状态请求体无效。');
          return;
        }
        writeJson(response, 200, await options.service.putPageState(body));
        return;
      }

      writeError(response, 404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
        return;
      }
      if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
        return;
      }
      if (error instanceof AssistantSessionServiceError) {
        writeError(response, serviceErrorStatus(error.code), error.code, error.message);
        return;
      }
      writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
    }
  };
}
