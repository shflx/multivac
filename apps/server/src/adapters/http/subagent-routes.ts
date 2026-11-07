import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SubagentQueries } from '../../application/subagent-queries.js';
import { isRemoteRequest } from './remote-policy.js';
import { TaskServiceError } from '../../modules/tasks/task-error.js';

export function createSubagentRequestHandler(queries: SubagentQueries) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/subagents' && !url.pathname.startsWith('/api/subagents/')) return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (isRemoteRequest(request)) { send(403, { error: { code: 'ACCESS_DENIED', message: '子智能体过程仅供本机查看。' } }); return true; }
    if (request.method !== 'GET') { send(405, { error: { code: 'INVALID_REQUEST', message: '子智能体过程只读。' } }); return true; }
    try {
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 20);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SyntaxError();
      if (url.pathname === '/api/subagents') {
        const parentSessionId = url.searchParams.get('parentSessionId'), taskId = url.searchParams.get('taskId');
        send(200, queries.page({ offset, limit, ...(parentSessionId ? { parentSessionId } : {}), ...(taskId ? { taskId } : {}), ...(url.searchParams.get('activeOnly') === 'true' ? { activeOnly: true } : {}) }));
      } else {
        const match = /^\/api\/subagents\/([A-Za-z0-9._:-]{1,128})\/process$/.exec(url.pathname);
        if (!match) throw new TaskServiceError('NOT_FOUND', '过程接口不存在。');
        send(200, queries.process(match[1]!, offset, limit));
      }
    } catch (error) { send(error instanceof TaskServiceError && error.code === 'NOT_FOUND' ? 404 : error instanceof SyntaxError ? 400 : 500,
      { error: { code: 'INVALID_REQUEST', message: error instanceof TaskServiceError ? error.message : '独立过程读取失败。' } }); }
    return true;
  };
}
