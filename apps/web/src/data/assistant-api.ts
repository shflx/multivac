import {
  AssistantApiErrorResponseSchema,
  AssistantPageStateSchema,
  AssistantSessionPageResponseSchema,
  type AssistantApiErrorCode,
  type AssistantPageState,
  type AssistantPageStatePut,
  type AssistantSessionPageResponse,
} from '@multivac/contracts';
import { Check } from 'typebox/value';

export class AssistantApiError extends Error {
  constructor(
    readonly code: AssistantApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AssistantApiError('INTERNAL_ERROR', '服务返回了无法解析的响应。', response.status);
  }
}

async function fetchJson<T>(url: string, init: RequestInit | undefined, schema: object): Promise<T> {
  const response = await fetch(url, init);
  const body = await responseJson(response);
  if (!response.ok) {
    if (Check(AssistantApiErrorResponseSchema, body)) {
      throw new AssistantApiError(body.error.code, body.error.message, response.status);
    }
    throw new AssistantApiError('INTERNAL_ERROR', '协调助手服务请求失败。', response.status);
  }
  if (!Check(schema, body)) {
    throw new AssistantApiError('INTERNAL_ERROR', '服务响应不符合协调助手契约。', response.status);
  }
  return body as T;
}

export function getAssistantSessionPage(
  before?: string,
  limit = 30,
): Promise<AssistantSessionPageResponse> {
  const parameters = new URLSearchParams({ limit: String(limit) });
  if (before) parameters.set('before', before);
  return fetchJson(
    `/api/assistant/session?${parameters.toString()}`,
    undefined,
    AssistantSessionPageResponseSchema,
  );
}

export function getAssistantPageState(): Promise<AssistantPageState> {
  return fetchJson('/api/assistant/page-state', undefined, AssistantPageStateSchema);
}

export function putAssistantPageState(
  state: AssistantPageStatePut,
  keepalive = false,
): Promise<AssistantPageState> {
  return fetchJson('/api/assistant/page-state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
    keepalive,
  }, AssistantPageStateSchema);
}
