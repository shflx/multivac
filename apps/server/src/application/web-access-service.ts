import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { WebAccessError, type WebProvider, type WebRequestContext } from '../modules/web/web-provider.js';

export interface WebAccessHost {
  lease(sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number): number;
  remainingMillis(sessionId: string): number;
}
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CONTENT_CHARS = 24000;
const shorten = (text: string, limit: number) => {
  const end = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(end) ? end.slice(0, -1) : end;
};

/** 只接受公开网页地址；不提供凭据、请求头、浏览器操作或本机网络读取入口。 */
export function publicWebUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebAccessError('网页地址必须是有效的 HTTP 或 HTTPS URL。'); }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '');
  // 首版保守拒绝 IP 字面量与内部主机名；公网域名的解析和目标访问仍由服务商负责。
  if (value.length > 8192 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/u.test(host)
    || (url.port && !['80', '443'].includes(url.port))) {
    throw new WebAccessError('只支持无用户名和密码的公开网页域名及标准 HTTP/HTTPS 端口，不支持本机、内网地址或 IP 字面量。');
  }
  url.hash = '';
  return url.href;
}

/** 统一参数、输出预算与生命周期；替换服务商不改变模型工具和任务执行边界。 */
export class WebAccessService {
  private readonly pending = new Map<string, { sessionId: string; controller: AbortController; done: Promise<void> }>();
  private closed = false;
  constructor(private readonly provider: WebProvider | (() => Promise<WebProvider>), private readonly host: WebAccessHost) {}
  get hasActivity(): boolean { return this.pending.size > 0; }
  stopped(sessionId: string): boolean { return ![...this.pending.values()].some(item => item.sessionId === sessionId); }
  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.pending.values()) item.controller.abort();
    await Promise.all([...this.pending.values()].map(item => item.done));
  }
  search(sessionId: string, input: { query: string; count?: number }, signal: AbortSignal): Promise<string> {
    const query = input.query.trim(), count = input.count ?? 5;
    if (!query || query.length > 1024 || !Number.isInteger(count) || count < 1 || count > 10) throw new WebAccessError('搜索词不能为空，最多 1024 字；结果数量须为 1 至 10。');
    return this.run(sessionId, signal, async context => {
      const provider = typeof this.provider === 'function' ? await this.provider() : this.provider;
      context.signal.throwIfAborted();
      const results = await provider.search({ query, count }, context);
      return { provider: provider.id, query, results: results.slice(0, count).map(item => {
        const title = shorten(item.title, 300), summary = shorten(item.summary, 2000);
        return { title, url: publicWebUrl(item.url), summary, publishedAt: item.publishedAt,
          truncated: title.length < item.title.length || summary.length < item.summary.length };
      }) };
    });
  }
  fetch(sessionId: string, input: { url: string }, signal: AbortSignal): Promise<string> {
    const url = publicWebUrl(input.url);
    return this.run(sessionId, signal, async context => {
      const provider = typeof this.provider === 'function' ? await this.provider() : this.provider;
      context.signal.throwIfAborted();
      const page = await provider.fetch(url, context);
      const content = shorten(page.content, MAX_CONTENT_CHARS), title = shorten(page.title, 300);
      return { provider: provider.id, url, title, content, truncated: content.length < page.content.length || title.length < page.title.length };
    });
  }
  private async run(sessionId: string, signal: AbortSignal, action: (context: WebRequestContext) => Promise<unknown>): Promise<string> {
    if (this.closed || signal.aborted) throw new WebAccessError('网页请求未执行，会话已停止。');
    const marker = randomUUID(), controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    this.pending.set(marker, { sessionId, controller, done });
    let leased = false, bytes = 0, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const maxBytes = Math.min(MAX_RESPONSE_BYTES, this.host.lease(sessionId, 'starting', marker, 0));
      leased = true;
      const millis = Math.min(30000, this.host.remainingMillis(sessionId));
      if (maxBytes < 1 || millis < 1) throw new WebAccessError('任务共享预算已耗尽，网页请求未执行。');
      timer = setTimeout(() => controller.abort(), millis);
      const combined = AbortSignal.any([signal, controller.signal]);
      const result = await action({ signal: combined, maxBytes, received: size => { bytes += size; } });
      if (combined.aborted) throw new WebAccessError('网页请求已取消或超时。');
      return JSON.stringify(result);
    } finally {
      if (timer) clearTimeout(timer);
      try { if (leased) this.host.lease(sessionId, 'settled', marker, bytes); }
      finally { this.pending.delete(marker); resolveDone(); }
    }
  }
}
