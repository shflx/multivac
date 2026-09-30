import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GLOBAL_EVENTS_PATH,
  WORKBENCH_SSE_EVENT_NAME,
  WindowIdSchema,
  type AssistantApiErrorCode,
  type AssistantApiErrorResponse,
  type WorkbenchEvent,
} from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { AssistantEventStream } from '../../application/assistant-event-stream.js';
import type { WorkbenchEvents } from '../../application/workbench-events.js';
import {
  AssistantEventCursorExpiredError,
  type AssistantEventRepository,
} from '../../modules/sessions/assistant-turn.js';
import {
  createSseConnection,
  formatSseEvent,
  parseEventCursor,
  streamPublicEvents,
  type SseConnection,
  type SseSink,
} from './sse-connection.js';

/**
 * 全局事件流的积压上限。
 *
 * 一条连接承载一个窗口的全部会话（全局 Multivac 加并排 4 栏同时流式输出，每秒可达数百条正文增量，
 * 每条约 0.2–0.5 KiB）与工作台变更，64 条 / 256 KiB 这样的单会话量级只够约 0.1 秒的停顿。
 * 积压只在 Node 输出缓冲与系统发送缓冲都写满后才开始，放宽到 1024 条 / 1 MiB（与工作台 WebSocket 的发送缓冲上限一致）：
 * 能容纳几秒的停顿与重连时的回放，内存仍有界；超过时照旧断开，由窗口按最后收到的游标续传。
 */
export const GLOBAL_EVENT_STREAM_MAX_QUEUED_EVENTS = 1024;
export const GLOBAL_EVENT_STREAM_MAX_QUEUED_BYTES = 1024 * 1024;

export interface EventStreamRoutesOptions {
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  /** 工作台变更；提供时全局事件流同时推送变更，并以查询参数中的窗口 id 登记连接。 */
  workbenchEvents?: WorkbenchEvents | undefined;
  heartbeatMs?: number | undefined;
  maxQueuedEvents?: number | undefined;
  maxQueuedBytes?: number | undefined;
}

function writeError(response: ServerResponse, status: number, code: AssistantApiErrorCode, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  const body: AssistantApiErrorResponse = { error: { code, message } };
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** 窗口 id 可以不带（不登记，收不到定向推送），带了就必须合法且只有一个。 */
function parseWindowId(url: URL): { windowId: string | null } | null {
  const values = url.searchParams.getAll('windowId');
  if (values.length === 0) return { windowId: null };
  if (values.length > 1 || !Check(WindowIdSchema, values[0])) return null;
  return { windowId: values[0]! };
}

/**
 * 工作台变更接入事件流：以窗口 id 登记（定向推送与“窗口是否在线”据此判断），先发 `workbench.connected`，
 * 之后按投递范围转发。不回放：连接前的变更由窗口在收到 `workbench.connected` 后整体重读。返回注销函数。
 */
function streamWorkbenchEvents(sink: SseSink, events: WorkbenchEvents, windowId: string | null): () => void {
  const send = (event: WorkbenchEvent) => sink.send(formatSseEvent(WORKBENCH_SSE_EVENT_NAME, event));
  const unsubscribe = events.subscribe((event, delivery) => {
    if (delivery.targetWindowId !== undefined && delivery.targetWindowId !== windowId) return;
    send(event);
  }, windowId);
  send({ type: 'workbench.connected', seq: events.nextSeq(), windowId });
  return unsubscribe;
}

/**
 * 全局事件流 `GET /api/events?after=<全局游标>&windowId=<窗口 id>`：每个窗口一条，推送所有会话的公共事件
 * （带 `id: cursor`，先回放再接实时）与工作台变更（不带游标、不回放）。建立在 SSE 连接（`sse-connection.ts`）上
 * （队列、背压、15 秒心跳）；连接关闭、写入失败或积压超限断开时，窗口登记随之注销。
 */
export function createEventStreamRequestHandler(options: EventStreamRoutesOptions) {
  const activeConnections = new Set<SseConnection>();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxQueuedEvents = options.maxQueuedEvents ?? GLOBAL_EVENT_STREAM_MAX_QUEUED_EVENTS;
  const maxQueuedBytes = options.maxQueuedBytes ?? GLOBAL_EVENT_STREAM_MAX_QUEUED_BYTES;

  const open = (sink: SseSink, cursor: string, windowId: string | null) => {
    // 先登记窗口并发出 workbench.connected，再回放会话事件：回放是同步的，期间不会插入其他事件。
    const releaseWorkbench = options.workbenchEvents
      ? streamWorkbenchEvents(sink, options.workbenchEvents, windowId)
      : () => {};
    try {
      const releasePublic = streamPublicEvents(sink, {
        initialCursor: cursor,
        eventRepository: options.eventRepository,
        eventStream: options.eventStream,
      });
      return () => {
        releaseWorkbench();
        releasePublic();
      };
    } catch (error) {
      releaseWorkbench();
      throw error;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== GLOBAL_EVENTS_PATH) return false;
    if (request.method !== 'GET') {
      writeError(response, 404, 'NOT_FOUND', '接口不存在。');
      return true;
    }
    const cursor = parseEventCursor(request, url, ['windowId']);
    const windowQuery = parseWindowId(url);
    if (cursor === null || windowQuery === null) {
      writeError(response, 400, 'INVALID_REQUEST', '事件流的游标或窗口参数无效或相互冲突。');
      return true;
    }

    try {
      // 在发送 SSE headers 前验证 cursor，失效时返回可解析的错误，窗口据此重读快照。
      options.eventRepository.listAfter(cursor, 1);
      let connection!: SseConnection;
      connection = createSseConnection({
        request,
        response,
        heartbeatMs,
        maxQueuedEvents,
        maxQueuedBytes,
        onClose: () => activeConnections.delete(connection),
        open: (sink) => open(sink, cursor, windowQuery.windowId),
      });
      activeConnections.add(connection);
      connection.start();
    } catch (error) {
      if (error instanceof AssistantEventCursorExpiredError) {
        writeError(response, 409, 'EVENT_CURSOR_EXPIRED', error.message);
      } else {
        writeError(response, 500, 'INTERNAL_ERROR', '服务处理请求时发生内部错误。');
      }
    }
    return true;
  };

  /** 断开全部连接（服务停止，或测试模拟网络中断），返回断开的条数。 */
  const disconnectAll = (): number => {
    const connections = [...activeConnections];
    for (const connection of connections) connection.close();
    activeConnections.clear();
    return connections.length;
  };

  return {
    handle,
    disconnectAll,
    activeConnectionCount: () => activeConnections.size,
  };
}

export type EventStreamRequestHandler = ReturnType<typeof createEventStreamRequestHandler>;
