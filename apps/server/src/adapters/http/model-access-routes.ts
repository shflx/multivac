import type { IncomingMessage, ServerResponse } from 'node:http';
import { Check } from 'typebox/value';
import { CancelModelCheckSchema, ConfigureModelApiKeySchema, MODEL_ACCESS_BODY_LIMIT_BYTES, ModelAccessCommandSchema } from '@multivac/contracts';
import { ModelAccessError } from '../../modules/model-settings/model-access.js';
import type { ModelAccessService } from '../../application/model-access-service.js';

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new ModelAccessError('INVALID_REQUEST');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      chunks.push(value); size += value.length;
      if (size > MODEL_ACCESS_BODY_LIMIT_BYTES) throw new ModelAccessError('INVALID_REQUEST');
    }
    const joined = Buffer.concat(chunks);
    try { return JSON.parse(joined.toString('utf8')) as unknown; }
    finally { joined.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

/** 秘密只存在于 POST body/一次 SDK 调用；错误永远只返回固定安全码。 */
export function createModelAccessRequestHandler(service: ModelAccessService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/model-access')) return false;
    let body: unknown;
    try {
      if (request.method === 'GET' && url.pathname === '/api/model-access') {
        send(response, 200, await service.getSnapshot()); return true;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/model-access/commands/')) {
        send(response, 200, await service.getReceipt(decodeURIComponent(url.pathname.slice('/api/model-access/commands/'.length)))); return true;
      }
      if (request.method !== 'POST') throw new ModelAccessError('NOT_FOUND');
      body = await readBody(request);
      if (url.pathname === '/api/model-access/api-key') {
        if (!Check(ConfigureModelApiKeySchema, body)) throw new ModelAccessError('INVALID_REQUEST');
        send(response, 200, await service.configure(body)); return true;
      }
      if (url.pathname === '/api/model-access/revoke-api-key') {
        if (!Check(ModelAccessCommandSchema, body)) throw new ModelAccessError('INVALID_REQUEST');
        send(response, 200, await service.revoke(body)); return true;
      }
      if (url.pathname === '/api/model-access/check') {
        if (!Check(ModelAccessCommandSchema, body)) throw new ModelAccessError('INVALID_REQUEST');
        send(response, 202, await service.startCheck(body)); return true;
      }
      if (url.pathname === '/api/model-access/cancel-check') {
        if (!Check(CancelModelCheckSchema, body)) throw new ModelAccessError('INVALID_REQUEST');
        send(response, 200, await service.cancelCheck(body.checkId)); return true;
      }
      throw new ModelAccessError('NOT_FOUND');
    } catch (error) {
      const code = error instanceof ModelAccessError ? error.code : error instanceof SyntaxError ? 'INVALID_REQUEST' : 'ACCESS_UNAVAILABLE';
      const status = code === 'INVALID_REQUEST' ? 400 : code === 'NOT_FOUND' ? 404
        : ['ACCESS_CONFLICT', 'COMMAND_ID_CONFLICT', 'CHECK_BUSY'].includes(code) ? 409
          : code === 'CREDENTIAL_UNSUPPORTED' ? 422 : 503;
      send(response, status, { error: { code } }); return true;
    } finally {
      if (typeof body === 'object' && body !== null && 'apiKey' in body) (body as { apiKey: unknown }).apiKey = '';
    }
  };
}
