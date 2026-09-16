import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MODEL_SETTINGS_BODY_LIMIT_BYTES,
  ModelSettingsApiErrorResponseSchema,
  SaveModelSettingsSchema,
  SetDefaultModelSchema,
  type ModelSettingsApiErrorCode,
  type ModelSettingsApiErrorResponse,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import {
  ModelSettingsService,
} from '../../application/model-settings-service.js';
import { ModelSettingsServiceError } from '../../modules/model-settings/model-settings.js';

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

function writeError(
  response: ServerResponse,
  status: number,
  code: ModelSettingsApiErrorCode,
  message: string,
): void {
  const body: ModelSettingsApiErrorResponse = { error: { code, message } };
  if (!Check(ModelSettingsApiErrorResponseSchema, body)) {
    throw new Error('模型设置错误响应不符合契约。');
  }
  writeJson(response, status, body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MODEL_SETTINGS_BODY_LIMIT_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text) as unknown;
}

function serviceErrorStatus(code: ModelSettingsApiErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'MODEL_SETTINGS_CANDIDATE_INVALID':
      return 400;
    case 'MODEL_SETTINGS_CONFLICT':
    case 'MODEL_SETTINGS_COMMAND_ID_CONFLICT':
      return 409;
    case 'DEFAULT_MODEL_UNAVAILABLE':
      return 422;
    case 'MODEL_SETTINGS_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

export function createModelSettingsRequestHandler(service: ModelSettingsService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/model-settings')) return false;

    try {
      if (request.method === 'GET' && url.pathname === '/api/model-settings') {
        writeJson(response, 200, await service.getSnapshot());
        return true;
      }
      if (
        request.method === 'POST' &&
        (url.pathname === '/api/model-settings/profiles' || url.pathname === '/api/model-settings/default')
      ) {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          writeError(response, 415, 'INVALID_REQUEST', '模型设置命令必须使用 application/json。');
          return true;
        }
        const body = await readJsonBody(request);
        if (url.pathname.endsWith('/profiles')) {
          if (!Check(SaveModelSettingsSchema, body)) {
            writeError(response, 400, 'INVALID_REQUEST', '模型配置命令请求体无效。');
            return true;
          }
          writeJson(response, 200, await service.save(body));
          return true;
        }
        if (!Check(SetDefaultModelSchema, body)) {
          writeError(response, 400, 'INVALID_REQUEST', '默认模型命令请求体无效。');
          return true;
        }
        writeJson(response, 200, await service.setDefault(body));
        return true;
      }

      writeError(response, 404, 'NOT_FOUND', '接口不存在。');
      return true;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
        return true;
      }
      if (error instanceof SyntaxError) {
        writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
        return true;
      }
      if (error instanceof ModelSettingsServiceError) {
        writeError(response, serviceErrorStatus(error.code), error.code, error.message);
        return true;
      }
      writeError(response, 500, 'INTERNAL_ERROR', '服务处理模型设置时发生内部错误。');
      return true;
    }
  };
}
