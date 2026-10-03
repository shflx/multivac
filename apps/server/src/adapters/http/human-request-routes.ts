import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { DecideHumanRequestSchema } from '@multivac/contracts';
import { HumanRequestService } from '../../application/human-request-service.js';
import { TaskServiceError } from '../../application/task-service.js';
import { ToolAuthorizationServiceError } from '../../application/tool-authorization-service.js';
import { body, BodyTooLarge } from './task-routes.js';
import { humanRequestQuery } from './human-request-query.js';
import { requestOrigin } from './window-origin.js';

export function createHumanRequestHandler(service: HumanRequestService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/task-requests(?:\/([A-Za-z0-9._:-]+)(?:\/(decision))?)?$/.exec(url.pathname);
    if (!match) return false;
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (!match[1] && request.method === 'GET') {
        json(200, service.page(humanRequestQuery(url.searchParams)));
        return true;
      }
      if (url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '人工请求决定和详情不接受查询参数。');
      if (!match[2] && request.method === 'GET') {
        json(200, { request: service.get(match[1]!) });
      } else if (match[1] && match[2] && request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '用户决定必须使用 JSON。');
        const input = await body(request);
        if (!Check(DecideHumanRequestSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '用户决定参数无效。');
        json(200, { request: await service.decide(match[1], input, requestOrigin(request)) });
      } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof TaskServiceError || error instanceof ToolAuthorizationServiceError;
      const code = known ? error.code : error instanceof BodyTooLarge ? 'BODY_TOO_LARGE' : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      json(code === 'BODY_TOO_LARGE' ? 413 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : code === 'INTERNAL_ERROR' ? 500 : 409, { error: { code, message: known ? error.message : '人工请求处理失败。' } });
    }
    return true;
  };
}
