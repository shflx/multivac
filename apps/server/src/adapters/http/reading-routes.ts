import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { BOOK_SOURCE_LIMIT_BYTES, BOOK_BINARY_LIMIT_BYTES, ImportBookSchema, AnnotationCommandSchema, ReadingScopeCommandSchema, ReadingNotesCommandSchema, CreateReadingDiscussionSchema, CollectReadingCommandSchema, CreateReadingCollectionTargetSchema } from '@multivac/contracts';
import type { ReadingService } from '../../application/reading-service.js';
import { ReadingError } from '../../modules/reading/book-import.js';

export function createReadingRequestHandler(service: ReadingService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/reading/')) return false;
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && path === '/api/reading/collection-targets') { send(200, { targets: service.targets() }); return true; }
      if (request.method === 'GET' && path === '/api/reading/collections') { send(200, { items: service.collectionItems(new URL(request.url!, 'http://localhost').searchParams.get('targetId') ?? 'reading-inbox') }); return true; }
      if (request.method === 'POST' && (path === '/api/reading/collections' || path === '/api/reading/collection-targets')) {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; if (size > 400000) throw new ReadingError('收集参数超过限制。', 413); chunks.push(b); }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (path === '/api/reading/collection-targets') {
          if (!Check(CreateReadingCollectionTargetSchema, input)) throw new ReadingError('接收目标参数无效。');
          send(200, service.createCollectionTarget(input.commandId, input.title));
        } else {
          if (!Check(CollectReadingCommandSchema, input)) throw new ReadingError('收集来源参数无效。');
          send(200, await service.collect(input));
        }
        return true;
      }
      if (request.method === 'GET' && path === '/api/reading/discussions') { send(200, { discussions: service.discussions() }); return true; }
      const discussions = /^\/api\/reading\/books\/([^/]+)\/discussions$/u.exec(path);
      if (discussions && request.method === 'GET') { send(200, { discussions: service.discussions(decodeURIComponent(discussions[1]!)) }); return true; }
      if (discussions && request.method === 'POST') {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; if (size > 400000) throw new ReadingError('讨论来源超过限制。', 413); chunks.push(b); }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Check(CreateReadingDiscussionSchema, input)) throw new ReadingError('讨论来源参数无效。');
        send(200, await service.createDiscussion(decodeURIComponent(discussions[1]!), input)); return true;
      }
      const notes = /^\/api\/reading\/books\/([^/]+)\/notes$/u.exec(path);
      if (notes && request.method === 'GET') { send(200, service.notes(decodeURIComponent(notes[1]!))); return true; }
      if (notes && request.method === 'POST') {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; if (size > 500000) throw new ReadingError('笔记请求超限。', 413); chunks.push(b); }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Check(ReadingNotesCommandSchema, input)) throw new ReadingError('笔记请求参数无效。');
        const id = decodeURIComponent(notes[1]!); await service.prepareNotes(id, input);
        send(200, service.mutateNotes(id, input)); return true;
      }
      const resource = /^\/api\/reading\/books\/([^/]+)\/(scope|companion)$/u.exec(path);
      if (resource) {
        const id = decodeURIComponent(resource[1]!);
        if (resource[2] === 'companion' && request.method === 'POST') { send(200, service.ensureCompanion(id)); return true; }
        if (resource[2] === 'scope' && request.method === 'GET') { send(200, service.scope(id)); return true; }
        if (resource[2] === 'scope' && request.method === 'POST') {
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) { const b = Buffer.from(chunk); size += b.length; if (size > 4096) throw new ReadingError('边界参数超限。', 413); chunks.push(b); }
          const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Check(ReadingScopeCommandSchema, input)) throw new ReadingError('已读边界参数无效。');
          send(200, service.setScope(id, input)); return true;
        }
        throw new ReadingError('不支持的阅读操作。', 405);
      }
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
          if (size > Math.max(BOOK_SOURCE_LIMIT_BYTES * 6, Math.ceil(BOOK_BINARY_LIMIT_BYTES / 3) * 4) + 4096) throw new ReadingError('导入请求超过限制。', 413);
          chunks.push(buffer);
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Check(ImportBookSchema, input)) throw new ReadingError('导入信息无效。支持 TXT、Markdown、PDF、EPUB。');
        send(200, await service.import(input));
      } else throw new ReadingError('不支持的读书接口。', 405);
    } catch (error) {
      const status = error instanceof ReadingError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
      send(status, { error: { code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: status === 500 ? '书籍保存或读取失败，请重试。' : (error as Error).message } });
    }
    return true;
  };
}
