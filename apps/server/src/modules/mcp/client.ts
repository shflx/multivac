import { randomUUID } from 'node:crypto';
import type { McpCatalog, McpErrorCode, McpJson, McpResource, McpResourceTemplate, McpTool } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { McpFactSchemas } from '@multivac/contracts';
import { McpError, mcpCanonical, mcpFingerprint, mcpToolId } from './mcp.js';

export type McpMessage = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
export interface McpWire {
  /** 本地连接已结束，但远程会话终结可能仍未知。 */
  readonly closeError?: McpErrorCode | null;
  start(receive: (message: McpMessage) => void, disconnected: () => void): Promise<void>;
  /** 异步准备完成后、实际发送前同步执行门禁和持久化意图，不得跳过 beforeSend。 */
  send(message: McpMessage, signal?: AbortSignal, beforeSend?: () => void): Promise<void>;
  close(): Promise<void>;
  negotiated?(protocolVersion: string): void;
}
export interface McpStdioChannel {
  /** 由宿主在来源、目录、环境、网络及执行租约核对后创建，不能直接执行模型提供的命令。 */
  write(bytes: string, beforeSend?: () => void): Promise<void>;
  listen(data: (bytes: Uint8Array) => void, exit: () => void): () => void;
  /** 等待实际退出；失败时不能声称进程已停止。 */
  close(): Promise<void>;
}
const MAX_BYTES = 2_000_000;

export class McpStdioWire implements McpWire {
  private channel: McpStdioChannel | null = null;
  private remove: (() => void) | null = null;
  private pending = Buffer.alloc(0);
  constructor(private readonly open: () => Promise<McpStdioChannel>) {}
  async start(receive: (message: McpMessage) => void, disconnected: () => void): Promise<void> {
    this.channel = await this.open();
    this.remove = this.channel.listen(bytes => {
      this.pending = Buffer.concat([this.pending, bytes]);
      if (this.pending.length > MAX_BYTES) { disconnected(); void this.close().catch(() => {}); return; }
      for (;;) {
        const newline = this.pending.indexOf(10);
        if (newline < 0) break;
        let line: string;
        try { line = new TextDecoder('utf-8', { fatal: true }).decode(this.pending.subarray(0, newline)); }
        catch { disconnected(); void this.close().catch(() => {}); return; }
        this.pending = this.pending.subarray(newline + 1);
        if (!line.trim()) continue;
        try { receive(parseMessage(JSON.parse(line))); }
        catch { disconnected(); void this.close().catch(() => {}); return; }
      }
    }, disconnected);
  }
  async send(message: McpMessage, signal?: AbortSignal, beforeSend?: () => void): Promise<void> {
    if (!this.channel) throw new McpError('connection-failed', 'MCP stdio 尚未连接。');
    const line = mcpCanonical(message);
    if (Buffer.byteLength(line) > MAX_BYTES) throw new McpError('limit-exceeded', 'MCP 请求超过大小限制。', 413);
    await this.channel.write(line + '\n', () => { if (signal?.aborted) throw new McpError('cancelled', 'MCP 请求尚未发送，已取消。'); beforeSend?.(); });
  }
  async close(): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    await channel.close();
    this.remove?.(); this.remove = null; this.channel = null; this.pending = Buffer.alloc(0);
  }
}

export interface McpHttpPolicy {
  /** 每个 HTTP 请求前复核地址、账号及宿主网络边界。禁止由重定向扩大目标。 */
  authorize(url: string): Promise<void>;
  credentials(): Promise<Readonly<Record<string, string>>>;
  /** 凭据等异步读取后、真正发请求前重新核对当前身份和规则。 */
  assertCurrent?(url: string): void;
}
/** Streamable HTTP 的 POST JSON / SSE 响应。不回退到旧 SSE，也不自动重发请求。 */
export class McpHttpWire implements McpWire {
  closeError: McpErrorCode | null = null;
  private receive: ((message: McpMessage) => void) | null = null;
  private sessionId: string | null = null;
  private protocol: string | null = null;
  private readonly controllers = new Set<AbortController>();
  private readonly drained = new Set<() => void>();
  constructor(private readonly url: string, private readonly policy: McpHttpPolicy, private readonly request: typeof fetch = fetch) {}
  async start(receive: (message: McpMessage) => void): Promise<void> { await this.policy.authorize(this.url); this.receive = receive; }
  async send(message: McpMessage, signal?: AbortSignal, beforeSend?: () => void): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      await this.policy.authorize(this.url);
      if (controller.signal.aborted) throw new McpError('cancelled', 'MCP 请求已取消。');
      const credentials = await this.policy.credentials();
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
      for (const [name, value] of Object.entries(credentials)) {
        if (name.toLowerCase() !== 'authorization') throw new McpError('invalid-config', 'MCP 认证头不受支持。');
        headers.set(name, value);
      }
      if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
      if (this.protocol) headers.set('MCP-Protocol-Version', this.protocol);
      const body = mcpCanonical(message);
      if (Buffer.byteLength(body) > MAX_BYTES) throw new McpError('limit-exceeded', 'MCP 请求超过大小限制。', 413);
      this.policy.assertCurrent?.(this.url);
      if (controller.signal.aborted) throw new McpError('cancelled', 'MCP 请求尚未发送，已取消。');
      beforeSend?.();
      const response = await this.request(this.url, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new McpError(response.status === 401 ? 'credential-unavailable' : 'connection-failed', 'MCP HTTP 请求被拒绝。'); }
      const session = response.headers.get('Mcp-Session-Id');
      if (session) {
        if (!/^[\x21-\x7e]{1,512}$/u.test(session) || (this.sessionId !== null && session !== this.sessionId))
          throw new McpError('identity-changed', 'MCP HTTP 会话身份变化。');
        this.sessionId = session;
      }
      if (response.status === 202 || response.status === 204) { await response.body?.cancel(); return; }
      const type = response.headers.get('Content-Type')?.split(';')[0]?.trim();
      if (type !== 'application/json' && type !== 'text/event-stream') { await response.body?.cancel(); throw new McpError('unsupported-protocol', 'MCP 响应类型不受支持。'); }
      await this.read(response, type === 'text/event-stream');
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(controller.signal.aborted ? 'cancelled' : 'connection-failed', 'MCP HTTP 连接失败或已取消。');
    } finally {
      signal?.removeEventListener('abort', abort); this.controllers.delete(controller);
      if (!this.controllers.size) { for (const done of this.drained) done(); this.drained.clear(); }
    }
  }
  private async read(response: Response, sse: boolean): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new McpError('connection-failed', 'MCP 响应为空。');
    let bytes = 0, buffer = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const deliver = (raw: string) => {
      const message = parseMessage(JSON.parse(raw));
      this.receive?.(message);
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > MAX_BYTES) throw new McpError('limit-exceeded', 'MCP 响应超过大小限制。', 413);
        buffer += decoder.decode(chunk.value, { stream: true });
        if (sse) {
          for (;;) {
            const match = /\r?\n\r?\n/u.exec(buffer);
            if (!match) break;
            const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
            if (data) deliver(data);
          }
        }
      }
      buffer += decoder.decode();
      if (!sse) deliver(buffer);
      else if (buffer.trim()) throw new McpError('unsupported-protocol', 'MCP SSE 响应未完整结束。');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  negotiated(protocolVersion: string): void {
    if (!['2025-06-18', '2025-03-26'].includes(protocolVersion)) throw new McpError('unsupported-protocol', '此协议版本不支持 Streamable HTTP。');
    this.protocol = protocolVersion;
  }
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    if (this.controllers.size) await new Promise<void>(resolve => this.drained.add(resolve));
    try {
      if (this.sessionId) {
        await this.policy.authorize(this.url);
        const headers = new Headers(await this.policy.credentials());
        headers.set('Mcp-Session-Id', this.sessionId);
        if (this.protocol) headers.set('MCP-Protocol-Version', this.protocol);
        this.policy.assertCurrent?.(this.url);
        const response = await this.request(this.url, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(3000) });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) this.closeError = 'result-unknown';
      }
    } catch { this.closeError = 'result-unknown'; }
    // 配置/账号撤销后不向旧地址发送新凭据；本地请求已收敛，远程关闭未知单独记录。
    this.sessionId = null; this.receive = null;
  }
}

function parseMessage(value: unknown): McpMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('unsupported-protocol', 'MCP 消息格式无效。');
  const message = value as McpMessage;
  if (message.jsonrpc !== '2.0' || (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')
    || (message.method !== undefined && typeof message.method !== 'string')) throw new McpError('unsupported-protocol', 'MCP 消息格式无效。');
  return message;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('unsupported-protocol', 'MCP 响应格式无效。');
  return value as Record<string, unknown>;
}

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export class McpClient {
  private readonly pending = new Map<string | number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private initialized = false;
  private ended = false;
  private capabilities: Record<string, unknown> = {};
  protocolVersion: string | null = null;
  constructor(private readonly wire: McpWire, private readonly changed: (kind: 'catalog' | 'disconnected') => void = () => {}, private readonly timeoutMs = 15000) {}
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.initialized || this.ended) throw new McpError('conflict', 'MCP 客户端不能重复初始化。');
    await this.wire.start(message => this.receive(message), () => this.disconnected());
    try {
      const result = record(await this.rpc('initialize', { protocolVersion: PROTOCOLS[0], capabilities: {}, clientInfo: { name: 'Multivac', version: '0.1.0' } }, signal));
      if (!PROTOCOLS.some(protocol => protocol === result.protocolVersion)) throw new McpError('unsupported-protocol', 'MCP 协议版本不受支持。');
      this.protocolVersion = String(result.protocolVersion); this.capabilities = record(result.capabilities);
      this.wire.negotiated?.(this.protocolVersion);
      await this.wire.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
      this.initialized = true;
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  private receive(message: McpMessage): void {
    if (this.ended) return;
    if (message.method) {
      if (message.id !== undefined) {
        // 不声明采样、elicitation 或 roots；服务端请求不能变成执行许可。
        const reply: McpMessage = message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability is not enabled' } };
        void this.wire.send(reply).catch(() => this.disconnected());
      } else if (['notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/resources/updated'].includes(message.method)) this.changed('catalog');
      return;
    }
    if (message.id === undefined) return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new McpError('connection-failed', 'MCP 服务返回协议错误。'));
    else if ('result' in message) waiter.resolve(message.result);
    else waiter.reject(new McpError('unsupported-protocol', 'MCP 响应缺少结果。'));
  }
  async rpc(method: string, params: unknown, signal?: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    if (this.ended || (method !== 'initialize' && !this.initialized)) throw new McpError('connection-failed', 'MCP 客户端未就绪。');
    if (signal?.aborted) throw new McpError('cancelled', 'MCP 调用尚未执行，已取消。');
    const id = randomUUID(), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const stop = (code: 'timeout' | 'cancelled') => {
          controller.abort();
          void this.wire.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: code } }).catch(() => {});
          reject(new McpError(code, 'MCP 调用超时或取消；远端结果须另行核对。'));
        };
        timer = setTimeout(() => stop('timeout'), this.timeoutMs);
        abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
        void this.wire.send({ jsonrpc: '2.0', id, method, params }, controller.signal, beforeSend).catch(error => reject(error instanceof McpError ? error : new McpError('connection-failed', 'MCP 连接中断。')));
      });
    } finally { controller.abort(); if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); this.pending.delete(id); }
  }
  get negotiatedCapabilities(): { tools: boolean; resources: boolean; resourceTemplates: boolean } {
    return { tools: !!this.capabilities.tools, resources: !!this.capabilities.resources, resourceTemplates: !!this.capabilities.resources };
  }
  private disconnected(): void {
    this.ended = true; this.initialized = false;
    for (const waiter of this.pending.values()) waiter.reject(new McpError('connection-failed', 'MCP 连接中断；在途结果须核对。'));
    this.pending.clear(); this.changed('disconnected');
  }
  async close(): Promise<void> { this.disconnected(); await this.wire.close(); }
  get closeError(): McpErrorCode | null { return this.wire.closeError ?? null; }
  async discover(binding: Pick<McpCatalog, 'serviceId' | 'accountId' | 'accountRevision' | 'configVersion'>, at: string, signal?: AbortSignal): Promise<McpCatalog> {
    const tools = this.capabilities.tools ? await this.pages('tools/list', 'tools', signal) : [];
    const resources = this.capabilities.resources ? await this.pages('resources/list', 'resources', signal) : [];
    const templates = this.capabilities.resources ? await this.pages('resources/templates/list', 'resourceTemplates', signal) : [];
    const directory = {
      tools: tools.map(value => this.tool(binding.serviceId, value)),
      resources: resources.map(value => this.resource(value, false) as McpResource),
      resourceTemplates: templates.map(value => this.resource(value, true) as McpResourceTemplate),
    };
    const catalog: McpCatalog = { ...binding, ...directory, catalogId: randomUUID(), revision: 1, discoveredAt: at, version: mcpFingerprint(directory) };
    if (!Check(McpFactSchemas.catalog, catalog)) throw new McpError('unsupported-protocol', 'MCP 目录超出支持范围。');
    return catalog;
  }
  private async pages(method: string, key: string, signal?: AbortSignal): Promise<unknown[]> {
    const all: unknown[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = record(await this.rpc(method, cursor ? { cursor } : {}, signal));
      if (!Array.isArray(page[key])) throw new McpError('unsupported-protocol', 'MCP 目录格式无效。');
      all.push(...page[key]);
      if (all.length > 1000 || Buffer.byteLength(mcpCanonical(all)) > MAX_BYTES) throw new McpError('limit-exceeded', 'MCP 目录超过限制。', 413);
      if (page.nextCursor === undefined) break;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 4096 || cursors.has(page.nextCursor) || cursors.size >= 100)
        throw new McpError('limit-exceeded', 'MCP 目录分页游标无效或重复。');
      cursor = page.nextCursor; cursors.add(cursor);
    } while (cursor);
    return all;
  }
  private tool(serviceId: string, value: unknown): McpTool {
    const raw = record(value);
    const definition = { name: raw.name, description: raw.description ?? '', inputSchema: raw.inputSchema, outputSchema: raw.outputSchema ?? null, annotations: raw.annotations ?? {} };
    return { ...definition, toolId: mcpToolId(serviceId, String(raw.name)), definitionVersion: mcpFingerprint(definition) } as McpTool;
  }
  private resource(value: unknown, template: boolean): McpResource | McpResourceTemplate {
    const raw = record(value), common = { name: raw.name, description: raw.description ?? '', mimeType: raw.mimeType ?? null };
    return (template ? { ...common, uriTemplate: raw.uriTemplate } : { ...common, uri: raw.uri }) as McpResource | McpResourceTemplate;
  }
}
