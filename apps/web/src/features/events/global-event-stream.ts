import { AssistantApiError, readAssistantEventRange, streamGlobalEvents } from '../../data/assistant-api.js';
import { GlobalEventRouter } from './event-router.js';

/** 断线后的重连间隔：从 250ms 起翻倍，最长 3 秒；连上后从头计。 */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 3_000;

function isCursorExpired(error: unknown): boolean {
  return error instanceof AssistantApiError && error.code === 'EVENT_CURSOR_EXPIRED';
}

/**
 * 本窗口唯一的一条全局事件流：所有会话的公共事件经 `router` 按会话分发（打开会话时的衔接见 `event-router.ts`）。
 *
 * - 起流：第一个到位的会话快照游标就是起点（它是服务端当时的最新游标），不从 0 回放历史。
 * - 断线（服务端断开、网络中断、积压超限）：从全局已处理游标续传。
 * - 游标过期（409）：已打开的会话各自重读快照，第一个新快照成为新的起点后重新起流。
 */
export class GlobalEventStream {
  readonly router: GlobalEventRouter;
  private opened = false;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;

  constructor() {
    this.router = new GlobalEventRouter({
      readRange: (sessionId, after, until) => readAssistantEventRange(sessionId, String(after), String(until)),
      isCursorExpired,
      onStart: () => this.connect(),
    });
  }

  /** 应用挂载时打开；已有起点时立即连接，否则等第一个快照。 */
  open(): void {
    this.opened = true;
    this.connect();
  }

  /** 应用卸载时关闭连接；全局游标保留，再次打开时从它续传。 */
  close(): void {
    this.opened = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.controller?.abort();
    this.controller = null;
  }

  private connect(): void {
    const cursor = this.router.cursor;
    if (!this.opened || this.controller || this.reconnectTimer !== undefined || cursor === null) return;
    const controller = new AbortController();
    this.controller = controller;
    streamGlobalEvents(String(cursor), controller.signal, {
      onOpen: () => {
        this.attempt = 0;
      },
      onAssistantEvent: (event) => this.router.dispatch(event),
    }).then(
      () => this.ended(controller, null),
      (error: unknown) => this.ended(controller, error),
    );
  }

  private ended(controller: AbortController, error: unknown): void {
    if (this.controller !== controller) return;
    this.controller = null;
    if (!this.opened || controller.signal.aborted) return;
    if (isCursorExpired(error)) {
      // 全局游标过期：所有会话重读快照，第一个到位的快照经 router 重新起流（onStart → connect）。
      this.router.expire();
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
