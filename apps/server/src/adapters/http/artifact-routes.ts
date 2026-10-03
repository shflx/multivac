import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { SubmitArtifactSchema } from '@multivac/contracts';
import { ArtifactService } from '../../application/artifact-service.js';
import { TaskServiceError } from '../../application/task-service.js';
import { body, BodyTooLarge } from './task-routes.js';
export function createArtifactHandler(service: ArtifactService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const task = /^\/api\/tasks\/([A-Za-z0-9._:-]+)\/artifacts$/.exec(url.pathname);
    const artifact = /^\/api\/artifacts\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (!task && !artifact) return false;
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '成果接口不接受查询参数。');
      if (artifact && request.method === 'GET') json(200, await service.read(artifact[1]!));
      else if (task && request.method === 'GET') json(200, { artifacts: service.list(task[1]!) });
      else if (task && request.method === 'POST') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new TaskServiceError('INVALID_REQUEST', '成果提交必须使用 JSON。');
        const input = await body(request);
        if (!Check(SubmitArtifactSchema, input)) throw new TaskServiceError('INVALID_REQUEST', '成果参数无效。');
        json(200, { version: await service.submit(task[1]!, input) });
      } else throw new TaskServiceError('NOT_FOUND', '接口不存在。');
    } catch (error) {
      const known = error instanceof TaskServiceError;
      const code = known ? error.code : error instanceof BodyTooLarge ? 'BODY_TOO_LARGE' : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
      json(code === 'BODY_TOO_LARGE' ? 413 : code === 'NOT_FOUND' ? 404 : code === 'INVALID_REQUEST' ? 400 : code === 'INTERNAL_ERROR' ? 500 : 409, { error: { code, message: known ? error.message : '成果读取或提交失败。' } });
    }
    return true;
  };
}
