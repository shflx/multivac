import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { CreateTaskSchema, UpdateTaskSchema, DeleteTaskSchema, CreateTaskGroupSchema, TaskQuerySchema, TaskControlSchema, type TaskQuery } from '@multivac/contracts';
import type { TaskExecutionService } from '../../application/task-execution-service.js';
import type { HumanRequestService } from '../../application/human-request-service.js';
import { AskTaskInputSchema } from '@multivac/contracts';
import { TaskService, TaskServiceError } from '../../application/task-service.js';
import { ProjectServiceError } from '../../application/project-service.js';
import { humanRequestQuery } from './human-request-query.js';
import { requestOrigin } from './window-origin.js';

export class BodyTooLarge extends Error {}
export async function body(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** 本地用户与内部工具复用 TaskService；HTTP 不直接写状态或调度执行。 */
export function createTaskRequestHandler(service: TaskService, execution?: TaskExecutionService, requests?: HumanRequestService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/(tasks|task-groups|task-session)(?:\/([A-Za-z0-9._:-]+))?(?:\/(control|requests|relations))?$/.exec(url.pathname);
    if (!match) return false;
    try {
      if (match[1] === 'task-session') {
        if (request.method !== 'GET' || match[3]) throw new TaskServiceError('NOT_FOUND', '接口不存在。');
        if (!match[2] || url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '会话关联查询无效。');
        json(response, 200, { task: service.bySession(match[2]) });
        return true;
      }
      const group = match[1] === 'task-groups';
      const id = match[2];
      if (match[3] === 'requests') {
        if (group || !id || !requests) throw new TaskServiceError('NOT_FOUND', '请求接口不存在。');
        if (request.method === 'GET') json(response, 200, requests.page(humanRequestQuery(url.searchParams, id)));
        else if (request.method === 'POST') {
          if (url.searchParams.size || !request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '澄清请求必须使用 JSON，且不接受查询参数。');
          const input = await body(request);
          if (!Check(AskTaskInputSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '澄清请求参数无效。');
          json(response, 200, { request: requests.create(id, 'clarification', input.question, input.commandId, null, requestOrigin(request)) });
        } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
        return true;
      }
      if (match[3] === 'relations') {
        if (group || !id || request.method !== 'GET') throw new TaskServiceError('NOT_FOUND', '关系接口不存在。');
        if ([...url.searchParams.keys()].some((key) => key !== 'ancestorOffset') || url.searchParams.getAll('ancestorOffset').length > 1) throw new TaskServiceError('INVALID_REQUEST', '关系查询条件无效。');
        const offset = url.searchParams.get('ancestorOffset');
        if (offset !== null && !/^[0-9]+$/.test(offset)) throw new TaskServiceError('INVALID_REQUEST', '祖先分页参数无效。');
        json(response, 200, service.relations(id, offset === null ? 0 : Number(offset)));
        return true;
      }
      if (match[3]) {
        if (group || !id || !execution || request.method !== 'POST') throw new TaskServiceError('NOT_FOUND', '接口不存在。');
        if (url.searchParams.size || !request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '任务控制必须使用 JSON，且不接受查询参数。');
        const input = await body(request);
        if (!Check(TaskControlSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '控制参数无效。');
        json(response, 200, await execution.control(id, input, requestOrigin(request)));
        return true;
      }
      if (request.method === 'GET') {
        if (group) {
          if (id || [...url.searchParams.keys()].some((key) => key !== 'projectId') || url.searchParams.getAll('projectId').length > 1) throw new TaskServiceError('INVALID_REQUEST', '分组查询条件无效。');
          const project = url.searchParams.get('projectId');
          json(response, 200, { groups: service.groups(project === 'daily' ? null : project ?? undefined) });
        } else if (id) {
          if ([...url.searchParams.keys()].some((key) => key !== 'before') || url.searchParams.getAll('before').length > 1) throw new TaskServiceError('INVALID_REQUEST', '详情查询条件无效。');
          const before = url.searchParams.get('before');
          if (before !== null && !/^[1-9][0-9]*$/.test(before)) throw new TaskServiceError('INVALID_REQUEST', '进展游标无效。');
          json(response, 200, service.detail(id, before === null ? undefined : Number(before)));
        } else {
          const query: Record<string, string | number | boolean> = {};
          for (const [key, value] of url.searchParams) {
            if (Object.hasOwn(query, key)) throw new TaskServiceError('INVALID_REQUEST', '查询参数不能重复。');
            if (key === 'limit' || key === 'offset') {
              if (!/^[0-9]+$/.test(value)) throw new TaskServiceError('INVALID_REQUEST', '分页参数无效。');
              query[key] = Number(value);
            } else if (key === 'includeRelations' || key === 'topLevel') {
              if (value !== 'true' && value !== 'false') throw new TaskServiceError('INVALID_REQUEST', '布尔查询参数无效。');
              query[key] = value === 'true';
            } else Object.defineProperty(query, key, { value: key === 'statuses' || key === 'excludeIds' || key === 'ids' ? value.split(',') : value, enumerable: true });
          }
          if (!Check(TaskQuerySchema, query)) throw new TaskServiceError('INVALID_REQUEST', '任务查询条件无效。');
          json(response, 200, service.list(query as TaskQuery));
        }
        return true;
      }
      if ((request.method !== 'POST' || id) && (request.method !== 'PATCH' || !id || group) && (request.method !== 'DELETE' || !id || group)) {
        json(response, 404, { error: { code: 'NOT_FOUND', message: '接口不存在。' } });
        return true;
      }
      if (url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '任务写入不接受查询参数。');
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        json(response, 415, { error: { code: 'INVALID_REQUEST', message: '必须使用 application/json。' } });
        return true;
      }
      const input = await body(request);
      const origin = requestOrigin(request);
      if (request.method === 'DELETE' && id) {
        if (!Check(DeleteTaskSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '删除任务参数无效。');
        json(response, 200, service.remove(id, input, origin));
      } else if (group) {
        if (!Check(CreateTaskGroupSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '分组参数无效。');
        json(response, 200, { group: service.createGroup(input, origin) });
      } else if (id) {
        if (!Check(UpdateTaskSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '修改参数无效。');
        json(response, 200, service.update(id, input, origin));
      } else {
        if (!Check(CreateTaskSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '创建参数无效。');
        json(response, 200, service.create(input, origin));
      }
    } catch (error) {
      const known = error instanceof TaskServiceError || error instanceof ProjectServiceError;
      const code = known ? error.code : error instanceof BodyTooLarge ? 'BODY_TOO_LARGE' : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      const status = code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : code === 'BODY_TOO_LARGE' ? 413 : code === 'INTERNAL_ERROR' ? 500 : 409;
      json(response, status, { error: { code, message: known ? error.message : status === 500 ? '服务处理请求时发生内部错误。' : '请求体无效或超过限制。' } });
    }
    return true;
  };
}
