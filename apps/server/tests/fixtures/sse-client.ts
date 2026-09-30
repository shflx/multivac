import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { ASSISTANT_SSE_EVENT_NAME, GLOBAL_EVENTS_PATH, type AssistantPublicEvent } from '@multivac/contracts';

/** 收到的一条 SSE 消息（注释行不计入）。 */
export interface SseMessage {
  id: string | undefined;
  event: string;
  data: any;
}

/**
 * 测试用的 SSE 客户端：连接事件流、按消息解析，`waitFor` 等待收到的消息满足条件。
 * 非 200 的响应按 JSON 读取正文，便于核对错误码。
 */
export function openEventStream(port: number, path: string, headers: Record<string, string> = {}) {
  const messages: SseMessage[] = [];
  let buffer = '';
  let req!: ClientRequest;
  let ended = false;
  const response = new Promise<{ status: number; body: any; raw: IncomingMessage }>((resolve, reject) => {
    req = request({
      hostname: '127.0.0.1', port, path,
      headers: { accept: 'text/event-stream', ...headers },
    }, (incoming) => {
      incoming.setEncoding('utf8');
      if (incoming.statusCode !== 200) {
        let text = '';
        incoming.on('data', (chunk: string) => { text += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, raw: incoming }));
        return;
      }
      incoming.on('data', (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const fields = new Map<string, string>();
          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const separator = line.indexOf(': ');
            fields.set(line.slice(0, separator), line.slice(separator + 2));
          }
          if (!fields.has('data')) continue;
          messages.push({ id: fields.get('id'), event: fields.get('event') ?? 'message', data: JSON.parse(fields.get('data')!) });
        }
      });
      const markEnded = () => { ended = true; };
      incoming.on('end', markEnded);
      incoming.on('close', markEnded);
      incoming.on('error', markEnded);
      resolve({ status: 200, body: undefined, raw: incoming });
    });
    req.on('error', (error) => {
      ended = true;
      reject(error);
    });
    req.end();
  });

  const waitUntil = async (condition: () => boolean, label: string, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`等待超时：${label}（已收到 ${messages.length} 条）`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  return {
    response,
    messages,
    /** 事件名为 name 的消息。 */
    named: (name: string) => messages.filter((message) => message.event === name),
    waitFor: (condition: (received: SseMessage[]) => boolean, label = '事件', timeoutMs?: number) =>
      waitUntil(() => condition(messages), label, timeoutMs),
    /** 等待服务端结束这条连接。 */
    waitForEnd: () => waitUntil(() => ended, '连接结束'),
    isEnded: () => ended,
    close() {
      req.destroy();
    },
  };
}

/**
 * 旁听会话公共事件：连接全局事件流 `/api/events`（不带窗口 id），只取 `assistant-event`；
 * 给出 assistantSessionId 时只取这个会话的事件（全局流推送所有会话，按 `assistantSessionId` 区分）。
 * `opened` 在连上后兑现（非 200 时拒绝）；`events` 是到目前为止收到的事件；`until` 等待第一条满足条件的事件（已收到的也算）。
 */
export function openSessionEvents(port: number, after: string, assistantSessionId?: string) {
  const stream = openEventStream(port, `${GLOBAL_EVENTS_PATH}?after=${encodeURIComponent(after)}`);
  const events = (): AssistantPublicEvent[] => stream.named(ASSISTANT_SSE_EVENT_NAME)
    .map((message) => message.data as AssistantPublicEvent)
    .filter((event) => assistantSessionId === undefined || event.assistantSessionId === assistantSessionId);
  return {
    opened: stream.response.then(({ status, body }) => {
      if (status !== 200) throw new Error(`事件流连接失败：${status} ${JSON.stringify(body)}`);
    }),
    get events() {
      return events();
    },
    async until(predicate: (event: AssistantPublicEvent) => boolean, timeoutMs = 10_000): Promise<AssistantPublicEvent> {
      await stream.waitFor(() => events().some(predicate), '会话事件', timeoutMs);
      return events().find(predicate)!;
    },
    close: stream.close,
  };
}
