import { WORKBENCH_EVENTS_PATH, WorkbenchEventSchema, type WorkbenchEvent } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { windowId } from './window-id.js';

/** 断线后的重连间隔：从 250ms 起翻倍，最长 3 秒。 */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 3_000;

/**
 * 订阅工作台变更事件（WebSocket，经开发服务器代理到本地服务）。连接时登记本窗口的 id；
 * 断线后自动重连，每次连上服务端都会先发 `workbench.connected`，调用方据此整体重读一次补齐断线期间的变化。
 * 不符合契约的消息直接丢弃。返回取消订阅的函数。
 */
export function subscribeWorkbenchEvents(onEvent: (event: WorkbenchEvent) => void): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: number | undefined;

  const connect = () => {
    if (closed) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams({ windowId: windowId() });
    const current = new WebSocket(`${protocol}//${window.location.host}${WORKBENCH_EVENTS_PATH}?${query}`);
    socket = current;
    current.onmessage = (message) => {
      let event: unknown;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Check(WorkbenchEventSchema, event)) return;
      if (event.type === 'workbench.connected') attempt = 0;
      onEvent(event);
    };
    current.onclose = () => {
      if (closed || socket !== current) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    closed = true;
    window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}
