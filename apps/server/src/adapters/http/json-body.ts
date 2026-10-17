import type { IncomingMessage } from 'node:http';

/** 未指定上限时的 JSON 请求体大小上限。 */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 128 * 1024;

/** 请求体超过上限；路由据此返回 413，不读取剩余内容。 */
export class RequestBodyTooLargeError extends Error {}

/**
 * 读取并解析 JSON 请求体：累计字节超过上限时立即抛出 RequestBodyTooLargeError，
 * 空正文或非法 JSON 抛出 SyntaxError。只负责协议层，业务校验由各路由按契约完成。
 */
export async function readJsonBody(request: IncomingMessage, limitBytes = DEFAULT_JSON_BODY_LIMIT_BYTES): Promise<unknown> {
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
  return JSON.parse(text) as unknown;
}
