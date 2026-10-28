import { randomBytes } from 'node:crypto';
import { parseWeixinApiJson } from './lossless-json.js';

export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const ILINK_METADATA = { channel_version: '2.4.10', bot_agent: 'Multivac/0.1.0' };
export type IlinkReply = { status: number; body: Record<string, unknown> };
export class IlinkError extends Error {
  constructor(readonly kind: 'timeout' | 'network' | 'address' | 'response') { super('微信接口暂不可用，请核对本地渠道状态。'); }
}
/** 只接受微信 iLink HTTPS 主机，拒绝用户信息、端口、路径及隐式重定向。 */
export function checkedIlinkBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new IlinkError('address'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/' && url.pathname !== '') || !/^ilink[a-z0-9-]*\.weixin\.qq\.com$/.test(url.hostname)) throw new IlinkError('address');
  return url.origin;
}
export function checkedQrUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new IlinkError('address'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new IlinkError('address');
  return url.href;
}
export function stringField(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
/** 与参考实现一致：HTTP 2xx 且未返回非零 ret／errcode 即成功；成功响应可以省略 ret。 */
export function ilinkSucceeded(reply: IlinkReply): boolean {
  return reply.status >= 200 && reply.status < 300 &&
    (reply.body.ret === undefined || reply.body.ret === 0) &&
    (reply.body.errcode === undefined || reply.body.errcode === 0);
}
export function invalidCredentials(reply: IlinkReply): boolean {
  return reply.status === 401 || reply.status === 403 || reply.body.errcode === -14 || reply.body.ret === -14;
}
const endpoints = new Set(['get_bot_qrcode', 'get_qrcode_status', 'getupdates', 'sendmessage', 'msg/notifystart', 'msg/notifystop']);

/** 独立文本客户端；无插件、模型、媒体或业务决定依赖。 */
export class IlinkClient {
  constructor(private readonly transport: typeof fetch = fetch, private readonly timeoutMs = 35_000) {}
  async request(base: string, endpoint: string, options: {
    token?: string; body?: Record<string, unknown>; query?: Record<string, string>; signal?: AbortSignal;
  } = {}): Promise<IlinkReply> {
    const origin = checkedIlinkBase(base);
    if (!endpoints.has(endpoint)) throw new IlinkError('address');
    const url = new URL(`/ilink/bot/${endpoint}`, origin);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x02040a) };
    if (options.body) {
      headers['Content-Type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.transport(url, { method: options.body ? 'POST' : 'GET', headers,
        ...(options.body ? { body: JSON.stringify({ ...options.body, base_info: ILINK_METADATA }) } : {}),
        signal: controller.signal, redirect: 'manual' });
      // 不跟随HTTP跳转，不向其目标发凭据；HTTP状态留给适配器分类。
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new IlinkError('response'); }
      const reader = response.body?.getReader();
      let text = '', bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new IlinkError('response'); }
          text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
      }
      const body = text ? parseWeixinApiJson<Record<string, unknown>>(text) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IlinkError('response');
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof IlinkError) throw error;
      throw new IlinkError(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  }
}
