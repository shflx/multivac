import type { IncomingMessage, ServerResponse } from 'node:http';
import { IMAGE_LIMITS } from '@multivac/contracts';
import { ImageError, type ImageService } from '../../application/image-service.js';

export function createImageRequestHandler(service: ImageService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const match = /^\/api\/sessions\/([^/]+)\/images(?:\/([a-f0-9]{64})(?:\/(content))?)?$/u.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (!match) return false;
    try {
      const sessionId = decodeURIComponent(match[1]!);
      let result: unknown;
      if (request.method === 'POST' && !match[2]) {
        if (Number(request.headers['content-length']) > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > IMAGE_LIMITS.bytes) throw new ImageError(413, '单图上限为 10 MiB。');
          chunks.push(Buffer.from(chunk));
        }
        result = await service.upload(sessionId, Buffer.concat(chunks));
      } else if (request.method === 'GET' && match[2]) {
        if (match[3]) {
          const { image, data } = await service.read(sessionId, match[2]);
          response.writeHead(200, { 'content-type': image.mimeType, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
          response.end(data); return true;
        }
        result = service.get(sessionId, match[2]);
      } else if (request.method === 'DELETE' && match[2] && !match[3]) {
        await service.remove(sessionId, match[2]); result = { ok: true };
      } else throw new ImageError(405, '不支持的请求方法。');
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof ImageError ? error.status : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: error instanceof ImageError ? error.message : '图片操作失败，请重试。' } }));
    }
    return true;
  };
}
