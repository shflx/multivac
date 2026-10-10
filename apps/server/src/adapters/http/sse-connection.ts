import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASSISTANT_EVENT_REPLAY_MAX_LIMIT,
  ASSISTANT_SSE_EVENT_NAME,
  type AssistantPublicEvent,
} from '@multivac/contracts';
import type { AssistantEventStream } from '../../application/assistant-event-stream.js';
import type { AssistantEventRepository } from '../../modules/sessions/assistant-turn.js';

/** 一条 SSE 连接的传输参数：心跳间隔与积压上限。 */
export interface SseTransportOptions {
  request: IncomingMessage;
  response: ServerResponse;
  heartbeatMs: number;
  /** 积压（发不出去而排队）的消息条数上限，超过即断开，由客户端按游标续传。 */
  maxQueuedEvents: number;
  /** 积压的字节数上限，超过即断开。 */
  maxQueuedBytes: number;
  onClose: () => void;
}

/** 开流时交给事件来源的写入口。 */
export interface SseSink {
  /** 推送一条已格式化的 SSE 消息；积压超限时连接随即关闭，之后的推送被忽略。 */
  send(chunk: string): void;
  isClosed(): boolean;
}

export interface SseConnectionOptions extends SseTransportOptions {
  /**
   * 写出响应头后同步调用：订阅事件来源并完成回放，返回连接关闭时的清理函数（取消订阅）。
   * 抛出异常时连接关闭，异常继续抛给调用方。
   */
  open(sink: SseSink): () => void;
}

export interface SseConnection {
  start(): void;
  close(): void;
  isClosed(): boolean;
}

/** 格式化一条 SSE 消息；带 id 的消息会成为客户端续传的游标。 */
export function formatSseEvent(event: string, data: unknown, id?: string): string {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 读取续传游标：查询参数 `after` 或 `Last-Event-ID` 头，两者都给出时必须相同，缺省为 `0`。
 * 除 `after` 与 extraKeys 外的查询参数、重复的 `after` 或非法值一律返回 null（400）。
 */
export function parseEventCursor(
  request: IncomingMessage,
  url: URL,
  extraKeys: readonly string[] = [],
): string | null {
  if ([...url.searchParams.keys()].some((key) => key !== 'after' && !extraKeys.includes(key))) return null;
  if (url.searchParams.getAll('after').length > 1) return null;
  const query = url.searchParams.get('after');
  const headerValue = request.headers['last-event-id'];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (query !== null && header !== undefined && query !== header) return null;
  const cursor = query ?? header ?? '0';
  return /^(0|[1-9][0-9]*)$/u.test(cursor) ? cursor : null;
}

/**
 * SSE 连接的传输层：响应头、心跳、写入队列与背压，事件来源由 open 接入。
 *
 * - 心跳是可丢弃的注释，连接背压或还有积压时不写；写入失败（连接关闭、出错）时连接关闭并调用清理函数。
 * - 背压：Node 输出缓冲写满后的消息进入队列，等 drain 后继续；积压超过条数或字节上限时直接断开，
 *   不在内存中无限堆积，由客户端按最后收到的游标续传。
 */
export function createSseConnection(options: SseConnectionOptions): SseConnection {
  const queue: string[] = [];
  let queuedBytes = 0;
  let closed = false;
  let started = false;
  let draining = false;
  let blocked = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let cleanup: (() => void) | undefined;
  const onDrain = () => {
    blocked = false;
    drain();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    cleanup?.();
    heartbeat = undefined;
    cleanup = undefined;
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

  const send = (chunk: string) => {
    if (closed) return;
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

      const release = options.open({ send, isClosed: () => closed });
      // 回放中积压超限会同步关闭连接，此时清理函数还没交回，直接释放订阅。
      if (closed) release();
      else cleanup = release;
    } catch (error) {
      close();
      throw error;
    }
  };

  return { start, close, isClosed: () => closed };
}

export interface PublicEventSourceOptions {
  initialCursor: string;
  eventRepository: AssistantEventRepository;
  eventStream: AssistantEventStream;
  /** 远程连接固定为全局对话；实时与回放共用此范围。 */
  sessionId?: string;
}

/**
 * 所有会话的公共事件（cursor 是全局递增值）：先订阅实时事件，再按游标分页回放已提交的事件；按 cursor 只增不减地去重，
 * 回放与实时之间不漏不重。每条事件带 `id: cursor`，事件名 `assistant-event`，由窗口按 `assistantSessionId` 分发。返回取消订阅。
 */
export function streamPublicEvents(sink: SseSink, options: PublicEventSourceOptions): () => void {
  let lastSent = Number(options.initialCursor);
  const forward = (event: AssistantPublicEvent) => {
    if (options.sessionId !== undefined && event.assistantSessionId !== options.sessionId) return;
    const cursor = Number(event.cursor);
    if (sink.isClosed() || cursor <= lastSent) return;
    lastSent = cursor;
    sink.send(formatSseEvent(ASSISTANT_SSE_EVENT_NAME, event, event.cursor));
  };

  const unsubscribe = options.eventStream.subscribe(forward);
  try {
    let replayCursor = options.initialCursor;
    while (!sink.isClosed()) {
      const replay = options.eventRepository.listAfter(replayCursor, ASSISTANT_EVENT_REPLAY_MAX_LIMIT, options.sessionId);
      for (const event of replay) forward(event);
      if (replay.length < ASSISTANT_EVENT_REPLAY_MAX_LIMIT) break;
      replayCursor = replay.at(-1)!.cursor;
    }
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}
