import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { GLOBAL_ASSISTANT_SESSION_ID, CreateScheduleSchema, UpdateScheduleSchema, ControlScheduleSchema, ScheduleDraftSchema, ScheduleQuerySchema } from '@multivac/contracts';
import type { ScheduleService } from '../../application/schedule-service.js';
import { TaskServiceError } from '../../modules/tasks/task-error.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';
import { isRemoteRequest } from './remote-policy.js';

export function createScheduleRequestHandler(service: ScheduleService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/schedules' && !url.pathname.startsWith('/api/schedules/')) return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (isRemoteRequest(request) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) { send(403, { error: { code: 'ACCESS_DENIED', message: '定时安排管理仅限本机。' } }); return true; }
    try {
      if (request.method === 'GET') {
        if (url.pathname === '/api/schedules/context') send(200, service.context(url.searchParams.get('timeZone') ?? undefined));
        else if (url.pathname === '/api/schedules') {
          const query = Object.fromEntries([...url.searchParams].map(([key,value]) => [key, ['offset','limit'].includes(key) ? Number(value) : value]));
          if (!Check(ScheduleQuerySchema, query)) throw new SyntaxError(); send(200, service.page(query));
        } else {
          const command = /^\/api\/schedules\/commands\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
          const detail = /^\/api\/schedules\/([A-Za-z0-9._:-]{1,128})$/.exec(url.pathname);
          if (command) send(200, service.reconcile(GLOBAL_ASSISTANT_SESSION_ID, command[1]!));
          else if (detail) {
            const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SyntaxError();
            send(200, service.detail(detail[1]!, offset, limit));
          } else send(404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
        }
      } else if (request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(415, { error: { code: 'INVALID_REQUEST', message: '请使用 application/json。' } }); return true; }
        const input = await readJsonBody(request, 80 * 1024);
        if (url.pathname === '/api/schedules' && Check(CreateScheduleSchema, input)) send(200, service.create(GLOBAL_ASSISTANT_SESSION_ID, input));
        else if (url.pathname === '/api/schedules/update' && Check(UpdateScheduleSchema, input)) send(200, service.update(GLOBAL_ASSISTANT_SESSION_ID, input));
        else if (url.pathname === '/api/schedules/control' && Check(ControlScheduleSchema, input)) send(200, service.control(GLOBAL_ASSISTANT_SESSION_ID, input));
        else if (url.pathname === '/api/schedules/preview' && Check(ScheduleDraftSchema, input)) send(200, { items: service.preview(input) });
        else throw new SyntaxError();
      } else send(405, { error: { code: 'INVALID_REQUEST', message: '不支持的请求方法。' } });
    } catch (error) {
      send(error instanceof RequestBodyTooLargeError ? 413 : error instanceof TaskServiceError ? error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_REQUEST' ? 400 : 409 : error instanceof SyntaxError || error instanceof RangeError ? 400 : 500,
        { error: { code: error instanceof TaskServiceError ? error.code : 'INVALID_REQUEST', message: error instanceof TaskServiceError ? error.message : '安排请求失败，请核对当前事实和原命令回执。' } });
    }
    return true;
  };
}
