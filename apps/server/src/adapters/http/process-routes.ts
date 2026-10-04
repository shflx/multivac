import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { ProcessStopSchema } from '@multivac/contracts';
import type { ManagedProcessService } from '../../application/managed-process-service.js';
import { TaskService, TaskServiceError } from '../../application/task-service.js';
import { body } from './task-routes.js';

export function createProcessRequestHandler(processes: ManagedProcessService, tasks: TaskService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/processes(?:\/([A-Za-z0-9._:-]+)\/(stop-preview|stop|logs))?$/.exec(url.pathname);
    if (!match) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const allowed = !match[1] ? 'offset' : match[2] === 'logs' ? 'after' : '';
      if ([...url.searchParams.keys()].some((key) => key !== allowed) || (allowed && url.searchParams.getAll(allowed).length > 1)) throw new TaskServiceError('INVALID_REQUEST', '进程查询参数无效。');
      const value = url.searchParams.get(allowed) ?? '0';
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER) throw new TaskServiceError('INVALID_REQUEST', '进程查询游标无效。');
      if (!match[1] && request.method === 'GET') {
        const items = processes.list(); const offset = Number(value);
        send(200, { processes: items.slice(offset, offset + 100).map((item) => {
          let task = null; try { task = tasks.get(item.taskId); } catch {}
          return { ...item, taskTitle: task?.title ?? null, taskAvailable: !!task, taskRunning: task?.status === 'running' };
        }), total: items.length, nextOffset: offset + 100 < items.length ? offset + 100 : null }); return true;
      }
      if (match[1] && match[2] === 'logs' && request.method === 'GET') { send(200, await processes.logs(match[1], Number(value))); return true; }
      const item = processes.list().find((item) => item.processId === match[1]);
      if (!item) throw new TaskServiceError('NOT_FOUND', '托管进程不存在。');
      let task = null;
      try { task = tasks.get(item.taskId); } catch { /* 来源已删除时仍能停止自身托管的进程。 */ }
      if (request.method === 'GET' && match[2] === 'stop-preview') send(200, processes.preview(item.processId, task));
      else if (request.method === 'POST' && match[2] === 'stop') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '停止请求必须使用 JSON。');
        const input = await body(request);
        if (!Check(ProcessStopSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '停止参数无效。');
        try { task = tasks.get(item.taskId); } catch { task = null; }
        send(200, { process: await processes.stopChecked(item.processId, input, task) });
      } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof TaskServiceError;
      const code = known ? error.code : 'INTERNAL_ERROR';
      send(code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : known ? 409 : 500,
        { error: { code, message: known ? error.message : '进程请求失败，请核对当前事实。' } });
    }
    return true;
  };
}
