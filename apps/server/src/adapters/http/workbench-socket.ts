import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { WORKBENCH_EVENTS_PATH, WindowIdSchema, type WorkbenchEvent } from '@multivac/contracts';
import { Check } from 'typebox/value';
import type { WorkbenchEvents } from '../../application/workbench-events.js';

export interface WorkbenchSocketOptions {
  events: WorkbenchEvents;
  /** 心跳间隔：每隔这么久 ping 一次，上一次 ping 没有回应的连接视为已断开。 */
  heartbeatMs?: number;
  /** 发送缓冲超过这个字节数（窗口长时间收不动）时断开，窗口重连后整体重读。 */
  maxBufferedBytes?: number;
}

/**
 * 工作台变更事件的推送通道：`GET /api/workbench/events?windowId=<窗口 id>` 升级为 WebSocket。
 *
 * 选 WebSocket 而不是再开一条 SSE：浏览器对同一主机的 HTTP/1.1 长连接最多 6 条，每个窗口已为全局 Multivac
 * 与各栏会话各占一条 SSE（并排 4 栏时 5 条），再加一条就会让其他请求排队；WebSocket 不占这个名额。
 * 通道只由服务端推送，窗口发来的消息一律忽略。连接建立后先发 `workbench.connected`，之后按投递范围转发变更事件：
 * 指定了目标窗口的只发给以该窗口 id 登记的连接。
 *
 * Host 与 Origin 的本地校验由 HTTP 服务在升级前统一完成（与普通请求同一套规则）。
 */
export function createWorkbenchSocket(options: WorkbenchSocketOptions) {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  // 窗口不发送业务消息，入站帧只需容纳关闭与心跳。
  const server = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const send = (socket: WebSocket, event: WorkbenchEvent) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // 窗口收不动时不在内存中无限堆积：断开后窗口重连，整体重读即可补齐。
    if (socket.bufferedAmount > maxBufferedBytes) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(event));
  };

  const accept = (socket: WebSocket, windowId: string | null) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    const unsubscribe = options.events.subscribe((event, delivery) => {
      if (delivery.targetWindowId !== undefined && delivery.targetWindowId !== windowId) return;
      send(socket, event);
    });
    socket.on('close', unsubscribe);
    socket.on('error', () => socket.terminate());
    send(socket, { type: 'workbench.connected', seq: options.events.nextSeq(), windowId });
  };

  return {
    /** 是否是工作台事件流的升级请求。 */
    handles(request: IncomingMessage): boolean {
      return new URL(request.url ?? '/', 'http://localhost').pathname === WORKBENCH_EVENTS_PATH;
    },

    /** 完成升级：窗口 id 经查询参数登记（可以不带，但带了就必须合法）。 */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const windowId = url.searchParams.get('windowId');
      const keys = [...url.searchParams.keys()];
      if (keys.some((key) => key !== 'windowId') || url.searchParams.getAll('windowId').length > 1 ||
          (windowId !== null && !Check(WindowIdSchema, windowId))) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      server.handleUpgrade(request, socket, head, (connection) => accept(connection, windowId));
    },

    connectionCount(): number {
      return server.clients.size;
    },

    /** 服务停止：断开全部连接（否则 HTTP 服务的 close 会一直等待）。 */
    close(): void {
      clearInterval(heartbeat);
      for (const socket of server.clients) socket.terminate();
      server.close();
    },
  };
}

export type WorkbenchSocket = ReturnType<typeof createWorkbenchSocket>;
