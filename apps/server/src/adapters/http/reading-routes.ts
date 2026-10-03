import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { BOOK_SOURCE_LIMIT_BYTES, ImportBookSchema, AnnotationCommandSchema } from '@multivac/contracts';
import type { ReadingService } from '../../application/reading-service.js';
import { ReadingError } from '../../modules/reading/book-import.js';

export function createReadingRequestHandler(service: ReadingService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/reading/')) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const annotations = /^\/api\/reading\/books\/([^/]+)\/annotations$/u.exec(path);
      if (annotations && request.method === 'GET') { send(200, { records: service.annotations(decodeURIComponent(annotations[1]!)) }); return true; }
      if (annotations && request.method === 'POST') {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 400000) throw new ReadingError('标注超过大小限制。', 413); chunks.push(buffer); }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Check(AnnotationCommandSchema, input)) throw new ReadingError('标注参数无效。');
        send(200, service.annotate(decodeURIComponent(annotations[1]!), input)); return true;
      }
      if (request.method === 'GET' && path === '/api/reading/books') send(200, { books: service.list() });
      else if (request.method === 'GET' && /^\/api\/reading\/books\/[^/]+$/u.test(path)) send(200, service.get(decodeURIComponent(path.split('/').at(-1)!)));
      else if (request.method === 'POST' && path === '/api/reading/books') {
        if (!request.headers['content-type']?.startsWith('application/json')) throw new ReadingError('导入请求必须使用 JSON。', 415);
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); size += buffer.length;
          if (size > BOOK_SOURCE_LIMIT_BYTES * 6 + 4096) throw new ReadingError('导入请求超过限制。', 413);
          chunks.push(buffer);
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Check(ImportBookSchema, input)) throw new ReadingError('导入信息无效。仅支持 TXT、Markdown。');
        send(200, await service.import(input));
      } else throw new ReadingError('不支持的读书接口。', 405);
    } catch (error) {
      const status = error instanceof ReadingError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      send(status, { error: { code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? '书籍保存或读取失败，请重试。' : (error as Error).message } });
    }
    return true;
  };
}
