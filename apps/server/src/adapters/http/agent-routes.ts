import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { CreateAgentSchema, DeleteAgentSchema, UpdateAgentSchema } from '@multivac/contracts';
import { AgentServiceError, type AgentService } from '../../application/agent-service.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';
import { requestOrigin } from './window-origin.js';

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** 设置 · 智能体与对话创建共用 AgentService；HTTP 只做参数校验与错误映射。 */
export function createAgentRequestHandler(service: AgentService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/agents(?:\/([A-Za-z0-9._:-]+))?$/.exec(url.pathname);
    if (!match) return false;
    const id = match[1];
    try {
      if (url.searchParams.size) throw new AgentServiceError('INVALID_REQUEST', '智能体接口不接受查询参数。');
      if (request.method === 'GET') {
        json(response, 200, id ? { agent: service.get(id), modelState: await service.modelState(service.get(id)) } : await service.list());
        return true;
      }
      if ((request.method !== 'POST' || id) && (request.method !== 'PATCH' || !id) && (request.method !== 'DELETE' || !id)) {
        throw new AgentServiceError('NOT_FOUND', '接口不存在。');
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        json(response, 415, { error: { code: 'INVALID_REQUEST', message: '必须使用 application/json。' } });
        return true;
      }
      const input = await readJsonBody(request);
      const origin = requestOrigin(request);
      if (request.method === 'POST') {
        if (!Check(CreateAgentSchema, input)) throw new AgentServiceError('INVALID_REQUEST', '智能体参数无效。');
        json(response, 200, await service.create(input, origin));
      } else if (request.method === 'PATCH') {
        if (!Check(UpdateAgentSchema, input)) throw new AgentServiceError('INVALID_REQUEST', '智能体修改参数无效。');
        json(response, 200, await service.update(id!, input, origin));
      } else {
        if (!Check(DeleteAgentSchema, input)) throw new AgentServiceError('INVALID_REQUEST', '删除智能体参数无效。');
        json(response, 200, service.remove(id!, input, origin));
      }
    } catch (error) {
      const known = error instanceof AgentServiceError;
      const code = known ? error.code : error instanceof RequestBodyTooLargeError ? 'BODY_TOO_LARGE' : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : code === 'BODY_TOO_LARGE' ? 413 : code === 'INTERNAL_ERROR' ? 500 : 409;
      json(response, status, { error: { code, message: known ? error.message : status === 500 ? '服务处理请求时发生内部错误。' : '请求体无效或超过限制。' } });
    }
    return true;
  };
}
