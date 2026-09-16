import {
  AssistantApiErrorResponseSchema,
  AssistantCommandReceiptSchema,
  AssistantCommandReconciliationResponseSchema,
  AssistantPageStateSchema,
  AssistantPublicEventSchema,
  AssistantSessionPageResponseSchema,
  type AssistantApiErrorCode,
  type AssistantPageState,
  type AssistantPageStatePut,
  type AssistantCommandReceipt,
  type AssistantCommandReconciliationResponse,
  type AssistantPublicEvent,
  type CancelAssistantTurnCommand,
  type SendAssistantMessageCommand,
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
    throw new AssistantApiError('INTERNAL_ERROR', 'Multivac 服务请求失败。', response.status);
  }
  if (!Check(schema, body)) {
    throw new AssistantApiError('INTERNAL_ERROR', '服务响应不符合 Multivac 契约。', response.status);
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

export function sendAssistantMessage(
  command: SendAssistantMessageCommand,
): Promise<AssistantCommandReceipt> {
  return fetchJson('/api/assistant/turns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  }, AssistantCommandReceiptSchema);
}

export function cancelAssistantTurn(
  command: CancelAssistantTurnCommand,
): Promise<AssistantCommandReceipt> {
  return fetchJson('/api/assistant/turns/current/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  }, AssistantCommandReceiptSchema);
}

export function getAssistantCommand(
  commandId: string,
): Promise<AssistantCommandReconciliationResponse> {
  return fetchJson(
    `/api/assistant/commands/${encodeURIComponent(commandId)}`,
    undefined,
    AssistantCommandReconciliationResponseSchema,
  );
}

function eventStreamError(error: unknown): AssistantApiError {
  return error instanceof AssistantApiError
    ? error
    : new AssistantApiError('INTERNAL_ERROR', '公共事件连接已中断，正在重连。', 0);
}

async function readAssistantEventStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: AssistantPublicEvent) => void,
): Promise<void> {
  if (!response.body) {
    throw new AssistantApiError('INTERNAL_ERROR', '公共事件响应缺少流式正文。', response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/u);
        const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
        if (eventName !== 'assistant-event') continue;
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        let body: unknown;
        try {
          body = JSON.parse(data);
        } catch {
          throw new AssistantApiError('INTERNAL_ERROR', '公共事件无法解析。', response.status);
        }
        if (!Check(AssistantPublicEventSchema, body)) {
          throw new AssistantApiError('INTERNAL_ERROR', '公共事件不符合契约。', response.status);
        }
        onEvent(body);
      }
      if (result.done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 响应可能已由 AbortController 或服务端关闭；继续释放 reader 引用。
    }
    reader.releaseLock();
  }
}

export function subscribeAssistantEvents(
  after: string,
  handlers: {
    onEvent: (event: AssistantPublicEvent) => void;
    onError: (error: AssistantApiError) => void;
  },
): () => void {
  let closed = false;
  let cursor = after;
  let controller: AbortController | undefined;
  let reconnectTimer: number | undefined;

  const connect = async () => {
    if (closed) return;
    const current = new AbortController();
    controller = current;
    try {
      const response = await fetch(
        `/api/assistant/events?after=${encodeURIComponent(cursor)}`,
        { headers: { accept: 'text/event-stream' }, signal: current.signal },
      );
      if (!response.ok) {
        const body = await responseJson(response);
        if (Check(AssistantApiErrorResponseSchema, body)) {
          throw new AssistantApiError(body.error.code, body.error.message, response.status);
        }
        throw new AssistantApiError('INTERNAL_ERROR', '公共事件连接失败。', response.status);
      }
      await readAssistantEventStream(response, current.signal, (event) => {
        cursor = event.cursor;
        handlers.onEvent(event);
      });
      if (!closed && controller === current) {
        throw new AssistantApiError('INTERNAL_ERROR', '公共事件连接已结束，正在重连。', 0);
      }
    } catch (error) {
      if (closed || current.signal.aborted || controller !== current) return;
      const apiError = eventStreamError(error);
      handlers.onError(apiError);
      if (apiError.code === 'EVENT_CURSOR_EXPIRED') return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => void connect(), 250);
    }
  };

  void connect();
  return () => {
    closed = true;
    window.clearTimeout(reconnectTimer);
    controller?.abort();
  };
}
