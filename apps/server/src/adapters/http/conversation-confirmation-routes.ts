import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { DecideHumanRequestSchema, GLOBAL_ASSISTANT_SESSION_ID } from '@multivac/contracts';
import type { InboxService } from '../../application/inbox-service.js';
import { TaskServiceError } from '../../application/task-service.js';
import { body, BodyTooLarge } from './task-routes.js';
import { requestOrigin } from './window-origin.js';

/** 外发仍走原确认服务；这里仅提供全局当前对话请求的入口，不能查询 Inbox 总览。 */
export function createConversationConfirmationHandler(service: InboxService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/assistant\/confirmations(?:\/([^/]+)(?:\/(decision|reconcile))?)?$/u.exec(url.pathname);
    if (!match) return false;
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (!match[1] && request.method === 'GET') {
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length || keys.some(key => !['offset', 'limit'].includes(key))) throw new TaskServiceError('INVALID_REQUEST', '确认列表只接受分页参数。');
        const offset = Number(url.searchParams.get('offset') ?? 0); const limit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TaskServiceError('INVALID_REQUEST', '分页参数无效。');
        json(200, service.conversationConfirmations(GLOBAL_ASSISTANT_SESSION_ID, offset, limit)); return true;
      }
      if (!match[1] || url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '确认详情参数无效。');
      const id = decodeURIComponent(match[1]);
      // 归属检查在读取请求正文与任何副作用之前，不信任客户端提供的 sessionId。
      const item = service.getConversationConfirmation(GLOBAL_ASSISTANT_SESSION_ID, id);
      if (!match[2] && request.method === 'GET') json(200, { item });
      else if (match[2] && request.method === 'POST') {
        if (match[2] === 'reconcile') json(200, { item: await service.reconcile(id) });
        else {
          if (!request.headers['content-type']?.startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '决定需要 JSON。');
          const input = await body(request);
          if (!Check(DecideHumanRequestSchema, input) || !['once', 'deny'].includes(input.decision)) throw new TaskServiceError('INVALID_REQUEST', '外发只能单次批准或拒绝。');
          json(200, { item: await service.decide(id, input, requestOrigin(request)) });
        }
      } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
    } catch (error) {
      const code = error instanceof TaskServiceError ? error.code : error instanceof BodyTooLarge ? 'BODY_TOO_LARGE' : error instanceof SyntaxError || error instanceof URIError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      json(code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : code === 'BODY_TOO_LARGE' ? 413 : code === 'INTERNAL_ERROR' ? 500 : 409, { error: { code, message: error instanceof TaskServiceError ? error.message : '当前对话确认处理失败。' } });
    }
    return true;
  };
}
