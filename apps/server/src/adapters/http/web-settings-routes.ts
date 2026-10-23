import type { IncomingMessage, ServerResponse } from 'node:http';
import { UpdateWebSettingsSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { WebSettingsError, type WebSettingsService } from '../../application/web-settings-service.js';
import { readJsonBody, RequestBodyTooLargeError } from './json-body.js';

/** 仅管理入口使用；模型工具只取得 Search/Fetch，不取得配置写入能力。 */
export function createWebSettingsRequestHandler(settings: WebSettingsService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/api/web-settings') return false;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body));
    };
    try {
      if (request.method === 'GET') send(200, await settings.get());
      else if (request.method === 'PUT') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new WebSettingsError('请使用 application/json。', 415);
        const input = await readJsonBody(request, 16000);
        if (!Check(UpdateWebSettingsSchema, input)) throw new WebSettingsError('网页配置请求无效，请检查服务商与密钥格式。', 400);
        send(200, await settings.update(input));
      } else throw new WebSettingsError('不支持的请求方法。', 405);
    } catch (error) {
      const status = error instanceof WebSettingsError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500;
      send(status, { error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: error instanceof WebSettingsError ? error.message : '网页配置请求失败，请核对保存结果。' } });
    }
    return true;
  };
}
