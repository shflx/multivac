import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { DecideHumanRequestSchema, UpdateInboxStateSchema, type InboxQuery } from '@multivac/contracts';
import type { InboxService } from '../../application/inbox-service.js';
import { TaskServiceError } from '../../application/task-service.js';
import { ToolAuthorizationServiceError } from '../../application/tool-authorization-service.js';
import { body, BodyTooLarge } from './task-routes.js';
import { requestOrigin } from './window-origin.js';

export function createInboxHandler(service: InboxService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/inbox(?:\/([^/]+)(?:\/(state|decision|reconcile))?)?$/.exec(url.pathname);
    if (!match) return false;
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const id = match[1] ? decodeURIComponent(match[1]) : null;
      if (!id && request.method === 'GET') {
        const query: Record<string, unknown> = {};
        for (const [key, value] of url.searchParams) {
          if (key in query) throw new TaskServiceError('INVALID_REQUEST', '不接受重复筛选参数。');
          query[key] = ['offset', 'limit'].includes(key) ? Number(value) : value;
        }
        json(200, service.page(query as InboxQuery));
      } else if (url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '详情接口不接受查询参数。');
      else if (id && !match[2] && request.method === 'GET') json(200, { item: service.get(id) });
      else if (id && match[2] && request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '请求必须使用 JSON。');
        const input = await body(request);
        if (match[2] === 'state') {
          if (!Check(UpdateInboxStateSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '草稿参数无效。');
          json(200, { state: service.updateState(id, input, requestOrigin(request)) });
        }
        else if (match[2] === 'reconcile') json(200, { item: await service.reconcile(id) });
        else {
          if (!Check(DecideHumanRequestSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '决定参数无效。');
          json(200, { item: await service.decide(id, input, requestOrigin(request)) });
        }
      } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof TaskServiceError || error instanceof ToolAuthorizationServiceError;
      const code = known ? error.code : error instanceof BodyTooLarge ? 'BODY_TOO_LARGE' : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      json(code === 'NOT_FOUND' ? 404 : code === 'BODY_TOO_LARGE' ? 413 : code === 'INVALID_REQUEST' ? 400 : code === 'INTERNAL_ERROR' ? 500 : 409, { error: { code, message: known ? error.message : 'Inbox 请求处理失败。' } });
    }
    return true;
  };
}
