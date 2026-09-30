import { request, type ClientRequest, type IncomingMessage } from 'node:http';

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
    waitFor: (condition: (received: SseMessage[]) => boolean, label = '事件') =>
      waitUntil(() => condition(messages), label),
    /** 等待服务端结束这条连接。 */
    waitForEnd: () => waitUntil(() => ended, '连接结束'),
    isEnded: () => ended,
    close() {
      req.destroy();
    },
  };
}
