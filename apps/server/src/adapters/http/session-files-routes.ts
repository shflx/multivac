import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionFilesError, type SessionFilesService } from '../../application/session-files-service.js';
import { WorkspaceSessionServiceError } from '../../application/workspace-session-service.js';

export function createSessionFilesRequestHandler(service: SessionFilesService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/sessions\/([^/]+)\/files$/u.exec(url.pathname);
    if (!match?.[1]) return false;
    let status = 200;
    let result: unknown;
    try {
      if (request.method !== 'GET') throw new SessionFilesError(405, '不支持的请求方法。');
      result = await service.list(decodeURIComponent(match[1]), url.searchParams.get('path') ?? '', url.searchParams.get('query') ?? '', url.searchParams.get('root') ?? undefined);
    } catch (error) {
      status = error instanceof SessionFilesError ? error.status : error instanceof WorkspaceSessionServiceError ? 404 : ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 403;
      result = { error: { code: status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', message: error instanceof SessionFilesError ? error.message : status === 404 ? '会话目录或文件不存在。' : '无法读取会话目录，请检查访问权限。' } };
    }
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(result));
    return true;
  };
}
