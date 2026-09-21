import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASSISTANT_DRAFT_MAX_UTF8_BYTES,
  ASSISTANT_EVENT_REPLAY_MAX_LIMIT,
  ASSISTANT_PAGE_STATE_BODY_LIMIT_BYTES,
  ASSISTANT_SSE_EVENT_NAME,
  ASSISTANT_TURN_BODY_LIMIT_BYTES,
  AssistantCommandReconciliationResponseSchema,
  AssistantPageStatePutSchema,
  AssistantSessionQuerySchema,
  AssistantToolExecutionQuerySchema,
  CancelAssistantTurnCommandSchema,
  SendAssistantMessageCommandSchema,
  type AssistantApiErrorCode,
  type AssistantApiErrorResponse,
  type AssistantPublicEvent,
  type AssistantSessionQuery,
  type AssistantToolExecutionQuery,
  SetSessionModelSchema, SetSessionThinkingLevelSchema,
} from '@multivac/contracts';
import type { SessionModelSelectionService } from '../../application/session-model-selection-service.js';
import { Check } from 'typebox/value';
import {
  AssistantSessionService,
  AssistantSessionServiceError,
} from '../../application/assistant-session-service.js';
import {
  AssistantTurnCommandService,
  AssistantTurnCommandServiceError,
} from '../../application/assistant-turn-command-service.js';
import { AssistantEventStream } from '../../application/assistant-event-stream.js';
import {
  AssistantEventCursorExpiredError,
  type AssistantEventRepository,
} from '../../modules/sessions/assistant-turn.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

class RequestBodyTooLargeError extends Error {}

function writable(response: ServerResponse): boolean {
  return !response.destroyed && !response.writableEnded;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (!writable(response)) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(value));
}

function writeError(
  response: ServerResponse,
  status: number,
  code: AssistantApiErrorCode,
  message: string,
): void {
  const body: AssistantApiErrorResponse = { error: { code, message } };
  writeJson(response, status, body);
}

function serviceErrorStatus(code: AssistantApiErrorCode): number {
  switch (code) {
    case 'INVALID_CURSOR':
    case 'INVALID_REQUEST':
      return 400;
    case 'PAGE_STATE_CONFLICT':
    case 'COMMAND_ID_CONFLICT':
    case 'EVENT_CURSOR_EXPIRED':
      return 409;
    case 'COMMAND_STATE_MISMATCH':
      return 422;
    case 'ASSISTANT_SESSION_BINDING_MISMATCH':
    case 'ASSISTANT_SESSION_RECOVERY_FAILED':
    case 'ASSISTANT_SESSION_UNAVAILABLE':
    case 'DEFAULT_MODEL_UNAVAILABLE':
      return 503;
    case 'NOT_FOUND':
      return 404;
    default:
      return 500;
  }
}

function parseSessionQuery(url: URL): AssistantSessionQuery | undefined {
  const allowed = new Set(['before', 'limit']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return undefined;
  const before = url.searchParams.get('before');
  const limitValue = url.searchParams.get('limit');
  if (url.searchParams.getAll('before').length > 1 || url.searchParams.getAll('limit').length > 1) {
    return undefined;
  }
  if (before !== null && before.length === 0) return undefined;
  if (limitValue !== null && !/^\d+$/u.test(limitValue)) return undefined;
  const query = {
    ...(before === null ? {} : { before }),
    ...(limitValue === null ? {} : { limit: Number(limitValue) }),
  };
  return Check(AssistantSessionQuerySchema, query) ? query : undefined;
}

function parseToolExecutionQuery(url: URL): AssistantToolExecutionQuery | undefined {
  const allowed = new Set(['before', 'limit']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return undefined;
  const before = url.searchParams.get('before');
  const limitValue = url.searchParams.get('limit');
  if (url.searchParams.getAll('before').length > 1 || url.searchParams.getAll('limit').length > 1) {
    return undefined;
  }
  if (before !== null && !/^(0|[1-9][0-9]*)$/u.test(before)) return undefined;
  if (limitValue !== null && !/^\d+$/u.test(limitValue)) return undefined;
  const query = {
    ...(before === null ? {} : { before }),
    ...(limitValue === null ? {} : { limit: Number(limitValue) }),
  };
  return Check(AssistantToolExecutionQuerySchema, query) ? query : undefined;
}

function parseEventCursor(request: IncomingMessage, url: URL): string | null {
  if ([...url.searchParams.keys()].some((key) => key !== 'after')) return null;
  if (url.searchParams.getAll('after').length > 1) return null;
  const query = url.searchParams.get('after');
  const headerValue = request.headers['last-event-id'];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (query !== null && header !== undefined && query !== header) return null;
  const cursor = query ?? header ?? '0';
  return /^(0|[1-9][0-9]*)$/u.test(cursor) ? cursor : null;
}

async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limitBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) throw new SyntaxError('empty body');
  return JSON.parse(text);
}

function commandPathId(pathname: string): string | null {
  const match = /^\/api\/assistant\/commands\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function toolExecutionPathId(pathname: string): string | null {
  const match = /^\/api\/assistant\/tools\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export interface AssistantSseConnectionOptions {
  response: ServerResponse;
  request: IncomingMessage;
  initialCursor: string;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  heartbeatMs: number;
  maxQueuedEvents: number;
  maxQueuedBytes: number;
  onClose: () => void;
}

export interface AssistantSseConnection {
  start(): void;
  close(): void;
  isClosed(): boolean;
}

export function createAssistantSseConnection(
  options: AssistantSseConnectionOptions,
): AssistantSseConnection {
  const queue: string[] = [];
  let queuedBytes = 0;
  let closed = false;
  let started = false;
  let draining = false;
  let blocked = false;
  let lastSent = Number(options.initialCursor);
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const onDrain = () => {
    blocked = false;
    drain();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    heartbeat = undefined;
    unsubscribe = undefined;
    options.response.off('drain', onDrain);
    options.request.off('aborted', close);
    options.response.off('close', close);
    options.response.off('error', close);
    queue.length = 0;
    queuedBytes = 0;
    options.onClose();
    if (!options.response.destroyed) options.response.destroy();
  };

  const writeEphemeral = (chunk: string) => {
    // heartbeat 可丢弃；连接背压时不继续向 Node 输出缓冲追加无界 comment。
    if (closed || blocked || queue.length > 0) return;
    if (!options.response.write(chunk)) blocked = true;
  };

  const drain = () => {
    if (closed || draining || blocked) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const chunk = queue.shift()!;
        queuedBytes -= Buffer.byteLength(chunk);
        if (!options.response.write(chunk)) {
          blocked = true;
          return;
        }
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = (event: AssistantPublicEvent) => {
    const cursor = Number(event.cursor);
    if (closed || cursor <= lastSent) return;
    lastSent = cursor;
    const chunk = `id: ${event.cursor}\nevent: ${ASSISTANT_SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`;
    queue.push(chunk);
    queuedBytes += Buffer.byteLength(chunk);
    if (queue.length > options.maxQueuedEvents || queuedBytes > options.maxQueuedBytes) {
      close();
      return;
    }
    drain();
  };

  const start = () => {
    if (started || closed) return;
    started = true;
    unsubscribe = options.eventStream.subscribe(enqueue);
    options.request.once('aborted', close);
    options.response.once('close', close);
    options.response.once('error', close);
    options.response.on('drain', onDrain);
    heartbeat = setInterval(() => {
      writeEphemeral(`: heartbeat ${Date.now()}\n\n`);
    }, options.heartbeatMs);
    heartbeat.unref();

    try {
      options.response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      options.response.flushHeaders();
      writeEphemeral(': connected\n\n');

      let replayCursor = options.initialCursor;
      while (!closed) {
        const replay = options.eventRepository.listAfter(replayCursor, ASSISTANT_EVENT_REPLAY_MAX_LIMIT);
        for (const event of replay) enqueue(event);
        if (replay.length < ASSISTANT_EVENT_REPLAY_MAX_LIMIT) break;
        replayCursor = replay.at(-1)!.cursor;
      }
    } catch (error) {
      close();
      throw error;
    }
  };

  return { start, close, isClosed: () => closed };
}

export interface AssistantRoutesOptions {
  service: AssistantSessionService;
  commandService: AssistantTurnCommandService;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  selectionService?: SessionModelSelectionService;
  pageStateBodyLimitBytes?: number;
  turnBodyLimitBytes?: number;
  heartbeatMs?: number;
  maxQueuedEvents?: number;
  maxQueuedBytes?: number;
}

export function createAssistantRequestHandler(options: AssistantRoutesOptions) {
  const activeConnections = new Set<AssistantSseConnection>();
  const pageStateBodyLimitBytes = options.pageStateBodyLimitBytes ?? ASSISTANT_PAGE_STATE_BODY_LIMIT_BYTES;
  const turnBodyLimitBytes = options.turnBodyLimitBytes ?? ASSISTANT_TURN_BODY_LIMIT_BYTES;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (options.selectionService && url.pathname.startsWith('/api/assistant/model-selection')) {
        if (request.method === 'GET' && url.pathname === '/api/assistant/model-selection') {
          return writeJson(response, 200, await options.selectionService.getOptions());
        }
        const commandMatch = /^\/api\/assistant\/model-selection\/commands\/([A-Za-z0-9._:-]{1,128})$/u.exec(url.pathname);
        if (request.method === 'GET' && commandMatch) return writeJson(response, 200, await options.selectionService.getCommand(commandMatch[1]!));
        if (request.method === 'POST' && ['/api/assistant/model-selection/model', '/api/assistant/model-selection/thinking'].includes(url.pathname)) {
          if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
            return writeError(response, 415, 'INVALID_REQUEST', '模型选择命令必须使用 application/json。');
          }
          const body = await readJsonBody(request, pageStateBodyLimitBytes);
          const isModel = url.pathname.endsWith('/model');
          if (isModel ? !Check(SetSessionModelSchema, body) : !Check(SetSessionThinkingLevelSchema, body)) {
            return writeError(response, 400, 'INVALID_REQUEST', '模型选择命令无效。');
          }
          const result = isModel
            ? await options.selectionService.setModel(body as import('@multivac/contracts').SetSessionModel)
            : await options.selectionService.setThinkingLevel(body as import('@multivac/contracts').SetSessionThinkingLevel);
          return writeJson(response, result.status === 'succeeded' ? 200 : result.status === 'unknown' ? 503 : 409, result);
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/assistant/session') {
        const query = parseSessionQuery(url);
        if (!query) return writeError(response, 400, 'INVALID_REQUEST', '会话分页参数无效。');
        return writeJson(response, 200, await options.service.getSessionPage(query));
      }

      if (request.method === 'GET' && url.pathname === '/api/assistant/tools') {
        const query = parseToolExecutionQuery(url);
        if (!query) return writeError(response, 400, 'INVALID_REQUEST', '工具执行分页参数无效。');
        return writeJson(response, 200, await options.service.listToolExecutions(query));
      }

      if (request.method === 'GET') {
        const toolCallId = toolExecutionPathId(url.pathname);
        if (toolCallId) {
          return writeJson(response, 200, await options.service.getToolExecution(toolCallId));
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/assistant/page-state') {
        return writeJson(response, 200, await options.service.getPageState());
      }

      if (request.method === 'PUT' && url.pathname === '/api/assistant/page-state') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          return writeError(response, 415, 'INVALID_REQUEST', '页面状态请求必须使用 application/json。');
        }
        const body = await readJsonBody(request, pageStateBodyLimitBytes);
        if (
          typeof body === 'object' && body !== null && 'draft' in body &&
          typeof body.draft === 'string' &&
          Buffer.byteLength(body.draft, 'utf8') > ASSISTANT_DRAFT_MAX_UTF8_BYTES
        ) {
          return writeError(response, 413, 'BODY_TOO_LARGE', '草稿超过可保存的大小限制。');
        }
        if (!Check(AssistantPageStatePutSchema, body)) {
          return writeError(response, 400, 'INVALID_REQUEST', '页面状态请求体无效。');
        }
        return writeJson(response, 200, await options.service.putPageState(body));
      }

      if (request.method === 'POST' && url.pathname === '/api/assistant/turns') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          return writeError(response, 415, 'INVALID_REQUEST', '消息命令必须使用 application/json。');
        }
        const body = await readJsonBody(request, turnBodyLimitBytes);
        if (
          typeof body === 'object' && body !== null && 'text' in body &&
          typeof body.text === 'string' &&
          Buffer.byteLength(body.text, 'utf8') > ASSISTANT_DRAFT_MAX_UTF8_BYTES
        ) {
          return writeError(response, 413, 'BODY_TOO_LARGE', '消息正文超过 12 KiB UTF-8 上限。');
        }
        if (!Check(SendAssistantMessageCommandSchema, body)) {
          return writeError(response, 400, 'INVALID_REQUEST', '消息命令请求体无效。');
        }
        const receipt = await options.commandService.send(body);
        if (receipt.terminalOutcome === 'rejected') {
          return writeError(
            response,
            422,
            receipt.error?.code === 'COMMAND_STATE_MISMATCH' ? 'COMMAND_STATE_MISMATCH' : 'INVALID_REQUEST',
            receipt.error?.message ?? '消息命令被拒绝。',
          );
        }
        return writeJson(response, receipt.status === 'terminal' ? 200 : 202, receipt);
      }

      if (request.method === 'POST' && url.pathname === '/api/assistant/turns/current/cancel') {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          return writeError(response, 415, 'INVALID_REQUEST', '取消命令必须使用 application/json。');
        }
        const body = await readJsonBody(request, pageStateBodyLimitBytes);
        if (!Check(CancelAssistantTurnCommandSchema, body)) {
          return writeError(response, 400, 'INVALID_REQUEST', '取消命令请求体无效。');
        }
        const receipt = await options.commandService.cancel(body);
        if (receipt.terminalOutcome === 'rejected') {
          return writeError(response, 422, 'COMMAND_STATE_MISMATCH', receipt.error?.message ?? '取消命令被拒绝。');
        }
        return writeJson(response, receipt.status === 'terminal' ? 200 : 202, receipt);
      }

      const commandId = request.method === 'GET' ? commandPathId(url.pathname) : null;
      if (commandId) {
        const result = options.commandService.get(commandId);
        if (!Check(AssistantCommandReconciliationResponseSchema, result)) {
          throw new Error('命令对账响应不符合契约。');
        }
        return writeJson(response, 200, result);
      }

      if (request.method === 'GET' && url.pathname === '/api/assistant/events') {
        const cursor = parseEventCursor(request, url);
        if (cursor === null) {
          return writeError(response, 400, 'INVALID_REQUEST', 'SSE cursor 参数无效或相互冲突。');
        }
        // 在发送 SSE headers 前验证 cursor，失效时返回可解析的 snapshot resync 错误。
        options.eventRepository.listAfter(cursor, 1);
        let connection!: AssistantSseConnection;
        connection = createAssistantSseConnection({
          request,
          response,
          initialCursor: cursor,
          eventRepository: options.eventRepository,
          eventStream: options.eventStream,
          heartbeatMs: options.heartbeatMs ?? 15_000,
          maxQueuedEvents: options.maxQueuedEvents ?? 64,
          maxQueuedBytes: options.maxQueuedBytes ?? 256 * 1024,
          onClose: () => activeConnections.delete(connection),
        });
        activeConnections.add(connection);
        connection.start();
        return;
      }

      writeError(response, 404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      if (!writable(response)) return;
      if (error instanceof RequestBodyTooLargeError) {
        return writeError(response, 413, 'BODY_TOO_LARGE', '请求体超过大小限制。');
      }
      if (error instanceof SyntaxError) {
        return writeError(response, 400, 'INVALID_REQUEST', '请求体不是有效 JSON。');
      }
      if (error instanceof AssistantEventCursorExpiredError) {
        return writeError(response, 409, 'EVENT_CURSOR_EXPIRED', error.message);
      }
      if (error instanceof AssistantTurnCommandServiceError) {
        return writeError(response, serviceErrorStatus(error.code), error.code, error.message);
      }
      if (error instanceof AssistantSessionServiceError) {
        return writeError(response, serviceErrorStatus(error.code), error.code, error.message);
      }
      writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
    }
  };

  return {
    handle,
    close() {
      for (const connection of [...activeConnections]) connection.close();
      activeConnections.clear();
    },
    activeConnectionCount: () => activeConnections.size,
  };
}
