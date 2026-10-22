import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import {
  CreateProjectResourceSchema,
  PROJECT_RESOURCE_UPLOAD_BODY_LIMIT_BYTES,
  UpdateProjectResourceSchema,
} from '@multivac/contracts';
import { ProjectResourceError, type ProjectResourceService } from '../../application/project-resource-service.js';
import { ProjectServiceError } from '../../application/project-service.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';
import { localFileActionAllowed } from './local-file-action.js';
import type { RequestAccess } from './remote-access.js';

const RESOURCE_PATH = /^\/api\/projects\/([^/]+)\/resources(?:\/([^/]+)(?:\/(open|reveal))?)?$/u;
const BROWSE_PATH = /^\/api\/projects\/([^/]+)\/directory-files$/u;

/**
 * 项目资料接口：
 * - GET/POST `/api/projects/:id/resources`：列出、添加；
 * - PATCH/DELETE `/api/projects/:id/resources/:resourceId`：改标题、简介与常驻，移除；
 * - POST `/api/projects/:id/resources/:resourceId/open|reveal`：用系统默认程序打开、在 Finder 中显示，只接受本机同源用户操作；
 * - GET `/api/projects/:id/directory-files?root=&path=&query=`：浏览项目目录，供“从项目目录选择”挑选文件。
 */
export function createProjectResourceRequestHandler(service: ProjectResourceService) {
  return async (request: IncomingMessage, response: ServerResponse, access?: RequestAccess): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const browsing = BROWSE_PATH.exec(url.pathname);
    const match = browsing ?? RESOURCE_PATH.exec(url.pathname);
    if (!match) return false;
    const send = (status: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const projectId = decodeURIComponent(match[1]!);
      if (browsing) {
        if (request.method !== 'GET') throw new ProjectResourceError(405, '不支持的请求方法。');
        const root = url.searchParams.get('root');
        if (!root) throw new ProjectResourceError(400, '请指定项目目录。');
        send(200, await service.browse(projectId, root, url.searchParams.get('path') ?? '', url.searchParams.get('query') ?? ''));
        return true;
      }
      const resourceId = match[2] === undefined ? null : decodeURIComponent(match[2]);
      const action = match[3];
      if (action) {
        if (request.method !== 'POST') throw new ProjectResourceError(405, '不支持的请求方法。');
        if (!localFileActionAllowed(request, access)) throw new ProjectResourceError(403, '打开资料只接受本机同源浏览器中的用户操作，远程访问不可用。');
        send(200, action === 'open' ? await service.open(projectId, resourceId!) : await service.reveal(projectId, resourceId!));
      } else if (resourceId === null && request.method === 'GET') {
        send(200, service.list(projectId));
      } else if (resourceId === null && request.method === 'POST') {
        const body = await readJsonBody(request, PROJECT_RESOURCE_UPLOAD_BODY_LIMIT_BYTES);
        if (!Check(CreateProjectResourceSchema, body)) throw new ProjectResourceError(400, '添加资料请求体无效。');
        send(201, { resource: service.create(projectId, body) });
      } else if (resourceId !== null && request.method === 'PATCH') {
        const body = await readJsonBody(request);
        if (!Check(UpdateProjectResourceSchema, body)) throw new ProjectResourceError(400, '修改资料请求体无效。');
        send(200, { resource: service.update(projectId, resourceId, body) });
      } else if (resourceId !== null && request.method === 'DELETE') {
        service.remove(projectId, resourceId);
        send(200, { removed: true });
      } else {
        throw new ProjectResourceError(405, '不支持的请求方法。');
      }
    } catch (error) {
      const status = error instanceof ProjectResourceError ? error.status
        : error instanceof ProjectServiceError ? (error.code === 'NOT_FOUND' ? 404 : 400)
          : error instanceof RequestBodyTooLargeError ? 413
            : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      const message = error instanceof ProjectResourceError || error instanceof ProjectServiceError ? error.message
        : status === 413 ? '文件过大，无法添加。'
          : status === 400 ? '请求无效。' : '项目资料处理失败，请重试。';
      send(status, { error: { code: status === 404 ? 'NOT_FOUND' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message } });
    }
    return true;
  };
}
