import type { IncomingMessage, ServerResponse } from 'node:http';
import { GLOBAL_ASSISTANT_SESSION_ID, TASK_ATTACHMENT_LIMITS } from '@multivac/contracts';
import type { AttachmentOwner, TaskAttachmentService } from '../../application/task-attachment-service.js';
import { TaskServiceError } from '../../modules/tasks/task-error.js';
import { ImageError } from '../../application/validate-image.js';

/** 仅经本机任务 API 开放；远程访问白名单不包含这些路径。 */
export function createTaskAttachmentHandler(service: TaskAttachmentService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const history = /^\/api\/tasks\/([A-Za-z0-9._:-]+)\/input-snapshots\/([A-Za-z0-9._:-]+)\/attachments\/([a-f0-9-]{36})\/content$/.exec(url.pathname);
    const match = /^\/api\/(tasks|task-attachment-drafts)\/([A-Za-z0-9._:-]+)\/attachments(?:\/([a-f0-9-]{36})(?:\/(content))?)?$/.exec(url.pathname);
    const session = /^\/api\/sessions\/([A-Za-z0-9._:-]+)\/attachment-drafts\/([A-Za-z0-9._:-]+)\/attachments(?:\/([a-f0-9-]{36})(?:\/(content))?)?$/.exec(url.pathname);
    if (!match && !history && !session) return false;
    if (session && session[1] !== GLOBAL_ASSISTANT_SESSION_ID) {
      response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: '文件附件仅支持全局 Multivac 对话。' } })); return true;
    }
    const route = session ?? match;
    const owner: AttachmentOwner = session ? { draftId: session[2]!, sessionId: session[1]! } : match?.[1] === 'tasks' ? { taskId: match[2]! } : { draftId: match?.[2] ?? '' };
    const json = (status: number, result: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result)); };
    const download = ({ attachment, data }: Awaited<ReturnType<TaskAttachmentService['read']>>) => {
      response.writeHead(200, { 'content-type': attachment.mimeType, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
      response.end(data);
    };
    try {
      if (history) {
        if (request.method !== 'GET' || url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '历史输入仅支持下载。');
        download(await service.readHistory(history[1]!, history[2]!, history[3]!)); return true;
      }
      if (!route) return false;
      let result: unknown;
      if (request.method === 'PUT' && route[3] && !route[4]) {
        if ([...url.searchParams.keys()].some(key => key !== 'name') || url.searchParams.getAll('name').length !== 1) throw new TaskServiceError('INVALID_REQUEST', '上传必须指定原文件名。');
        if (Number(request.headers['content-length']) > TASK_ATTACHMENT_LIMITS.bytes) throw new ImageError(413, '单文件上限 10 MiB。');
        result = await service.receive(owner, route[3], url.searchParams.get('name')!, async () => {
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > TASK_ATTACHMENT_LIMITS.bytes) throw new ImageError(413, '单文件上限 10 MiB。');
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        });
      } else {
        if (url.searchParams.size) throw new TaskServiceError('INVALID_REQUEST', '附件读取不接受查询参数。');
        if (request.method === 'GET' && !route[3]) result = { attachments: service.list(owner) };
        else if (request.method === 'GET' && route[3] && route[4]) {
          download(await service.read(owner, route[3])); return true;
        } else if (request.method === 'DELETE' && route[3] && !route[4]) { service.remove(owner, route[3]); result = { ok: true }; }
        else throw new TaskServiceError('NOT_FOUND', '附件接口不存在。');
      }
      json(200, result);
    } catch (error) {
      const known = error instanceof TaskServiceError || error instanceof ImageError;
      json(error instanceof ImageError ? error.status : error instanceof TaskServiceError ? error.code === 'NOT_FOUND' ? 404 : 409 : 500, { error: { code: error instanceof TaskServiceError ? error.code : 'INVALID_REQUEST', message: known ? error.message : '附件操作失败，请核对上传状态后重试。' } });
    }
    return true;
  };
}
