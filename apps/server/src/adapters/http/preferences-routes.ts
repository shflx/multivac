import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PREFERENCES_BODY_LIMIT_BYTES,
  UpdatePreferencesSchema,
  type AssistantApiErrorCode,
  type PreferencesResponse,
  type TempDirectoryUsage,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { PreferencesService } from '../../application/preferences-service.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RequestBodyTooLargeError extends Error {}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  writeJson(response, status, { error: { code, message } });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > PREFERENCES_BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

export interface PreferencesRoutesOptions {
  preferences: PreferencesService;
  /** 临时目录的总占用（服务端遍历计算）。 */
  tempDirectoryUsage: () => Promise<TempDirectoryUsage>;
}

/**
 * 偏好接口：`/api/preferences`（读取、按字段更新）与 `/api/temp-directories/usage`（临时目录的总占用，只读）。
 * 偏好保存在服务端，改完即生效。
 */
export function createPreferencesRequestHandler(options: PreferencesRoutesOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/preferences' && url.pathname !== '/api/temp-directories/usage') return false;

    try {
      if (url.pathname === '/api/temp-directories/usage') {
        if (request.method !== 'GET') {
          writeError(response, 405, 'INVALID_REQUEST', '不支持的请求方法。');
          return true;
        }
        writeJson(response, 200, await options.tempDirectoryUsage());
        return true;
      }
      if (request.method === 'GET') {
        const body: PreferencesResponse = { preferences: options.preferences.get() };
        writeJson(response, 200, body);
        return true;
      }
      if (request.method !== 'PATCH') {
        writeError(response, 405, 'INVALID_REQUEST', '不支持的请求方法。');
        return true;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        writeError(response, 415, 'INVALID_REQUEST', '更新偏好必须使用 application/json。');
        return true;
      }
      const patch = await readJsonBody(request);
      if (!Check(UpdatePreferencesSchema, patch)) {
        writeError(response, 400, 'INVALID_REQUEST', '偏好请求体无效：临时目录保留时长只能是 7、30、90 天或从不（null），任务执行时长只能是 30 分钟、2、6 或 24 小时。');
        return true;
      }
      const body: PreferencesResponse = { preferences: options.preferences.update(patch) };
      writeJson(response, 200, body);
      return true;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      } else if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
      return true;
    }
  };
}
