import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestAccess } from './remote-access.js';
import { localFileActionAllowed } from './local-file-action.js';
import { SessionFilesError, type SessionFilesService } from '../../application/session-files-service.js';
import { WorkspaceSessionServiceError } from '../../application/workspace-session-service.js';

export function createSessionFilesRequestHandler(service: SessionFilesService) {
  return async (request: IncomingMessage, response: ServerResponse, access?: RequestAccess): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/sessions\/([^/]+)\/files(?:\/(content|target|reveal))?$/u.exec(url.pathname);
    if (!match?.[1]) return false;
    let status = 200;
    let result: unknown;
    try {
      const revealing = match[2] === 'reveal';
      if (request.method !== (revealing ? 'POST' : 'GET')) throw new SessionFilesError(405, '不支持的请求方法。');
      if (revealing && !localFileActionAllowed(request, access)) throw new SessionFilesError(403, '系统定位只接受本机同源浏览器用户操作，远程或无合法用户上下文的请求不可用。');
      const id = decodeURIComponent(match[1]);
      const path = url.searchParams.get('path') ?? '';
      const root = url.searchParams.get('root') ?? undefined;
      if (match[2] === 'target' || revealing) {
        const kind = url.searchParams.get('kind');
        if (!root || (kind !== 'file' && kind !== 'directory')) throw new SessionFilesError(400, '请指定原工作目录与目标类型。');
        result = revealing ? await service.reveal(id, path, root, kind) : await service.target(id, path, root, kind);
      } else result = match[2] === 'content' ? await service.read(id, path, root) : await service.list(id, path, url.searchParams.get('query') ?? '', root);
    } catch (error) {
      status = error instanceof SessionFilesError ? error.status : error instanceof WorkspaceSessionServiceError ? 404 : ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? 404 : 403;
      result = { error: { code: status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', message: error instanceof SessionFilesError ? error.message : status === 404 ? '会话目录或文件不存在。' : '无法读取会话目录，请检查访问权限。' } };
    }
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    }
    return true;
  };
}
