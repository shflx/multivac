import { WebAccessError, type WebPage, type WebProvider, type WebRequestContext, type WebSearchInput, type WebSearchResult } from '../../modules/web/web-provider.js';

const ENDPOINT = 'https://api.deepseek.com/v1/tools/';
const invalidResponse = () => new WebAccessError('网页服务返回了无法识别的数据。');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 仅向固定 DeepSeek 地址发送凭据；目标网页由服务商读取，本机不直连目标 URL。 */
export class DeepSeekWebProvider implements WebProvider {
  readonly id = 'deepseek';
  constructor(private readonly apiKey: string, private readonly request: typeof globalThis.fetch = globalThis.fetch) {}

  async search(input: WebSearchInput, context: WebRequestContext): Promise<WebSearchResult[]> {
    // DeepSeek 按 Unicode 字符计数，不将 UTF-16 代理对算成两个字符。
    if ([...input.query].length > 128) throw new WebAccessError('DeepSeek 搜索词最多支持 128 个字符，请缩短查询。');
    const data = await this.post('search', { query: input.query, count: input.count, need_content: false }, context);
    if (!record(data) || !Array.isArray(data.results) || data.results.length > input.count) throw invalidResponse();
    return data.results.map((item): WebSearchResult => {
      if (!record(item) || typeof item.title !== 'string' || typeof item.url !== 'string'
        || typeof item.summary !== 'string' || (item.date != null && typeof item.date !== 'string')) throw invalidResponse();
      return { title: item.title, url: item.url, summary: item.summary, publishedAt: typeof item.date === 'string' ? item.date : null };
    });
  }

  async fetch(url: string, context: WebRequestContext): Promise<WebPage> {
    const data = await this.post('fetch', { url }, context);
    if (!record(data) || typeof data.title !== 'string' || typeof data.content !== 'string' || !data.content.trim()) throw invalidResponse();
    return { url, title: data.title, content: data.content };
  }

  private async post(operation: 'search' | 'fetch', body: unknown, context: WebRequestContext): Promise<unknown> {
    context.signal.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await this.request(`${ENDPOINT}${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: context.signal,
      });
      if (response.status !== 200) {
        const messages: Record<number, string> = {
          400: '网页服务拒绝了参数，请检查查询或 URL。', 401: '网页服务认证失败，请检查服务端 API Key。',
          402: '网页服务余额不足。', 403: '网页服务不允许读取此网页。', 404: '网页无法读取，或没有可提取的正文。',
          408: '网页服务请求超时。', 429: '网页服务请求过于频繁，请稍后重试。',
        };
        throw new WebAccessError(messages[response.status] ?? '网页服务暂时不可用，请稍后重试。');
      }
      if (!response.body) throw invalidResponse();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { context.signal.throwIfAborted(); break; }
          bytes += chunk.value.byteLength;
          context.received(chunk.value.byteLength);
          context.signal.throwIfAborted();
          if (bytes > context.maxBytes) throw new WebAccessError('网页服务响应超过读取上限，请缩小查询范围或读取较短页面。');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof WebAccessError) throw error;
      if (context.signal.aborted) throw new WebAccessError('网页请求已取消或超时。');
      // 不透传远端错误正文或底层异常，避免凭据出现在工具结果及消息历史中。
      throw new WebAccessError('网页服务连接失败或响应无效，请稍后重试。');
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }
}

