import { randomUUID } from 'node:crypto';
import type { McpAccount, McpCatalog, McpConnection, McpHost, McpService } from '@multivac/contracts';
import { McpClient, type McpWire } from './client.js';
import { McpError, mcpFingerprint, type McpRepository } from './mcp.js';

export interface McpConnectionContext { sessionId: string; host: McpHost }
export interface McpWireFactory {
  /** 只构造传输，启动放在 wire.start；复核宿主来源/进程/目录/网络策略，账号值只在私有边界解析。 */
  open(service: McpService, account: McpAccount, context: McpConnectionContext, signal?: AbortSignal): Promise<McpWire>;
}
interface LiveConnection { client: McpClient; record: McpConnection; catalog: McpCatalog | null; generation: number }

/** 会话间不共享连接，配置变化不偷偷换账号，重连必须显式创建新连接。 */
export class McpConnections {
  private readonly live = new Map<string, LiveConnection>();
  constructor(private readonly repository: McpRepository, private readonly factory: McpWireFactory, private readonly now = () => new Date().toISOString()) {}
  async connect(serviceId: string, accountId: string, context: McpConnectionContext, signal?: AbortSignal): Promise<{ connection: McpConnection; catalog: McpCatalog }> {
    const { service, account } = this.current(serviceId, accountId);
    if (service.transport.kind === 'legacy-sse') throw new McpError('unsupported-transport', '不支持旧 HTTP+SSE；请提供 Streamable HTTP 地址。', 400);
    if (signal?.aborted) throw new McpError('cancelled', 'MCP 连接尚未执行，已取消。');
    const record: McpConnection = { connectionId: randomUUID(), sessionId: context.sessionId, serviceId, accountId, accountRevision: account.revision,
      configVersion: service.configVersion, revision: 1, state: 'connecting', protocolVersion: null,
      capabilities: { tools: false, resources: false, resourceTemplates: false }, errorCode: null, updatedAt: this.now() };
    this.save(record, 0);
    let client: McpClient | null = null;
    try {
      const wire = await this.factory.open(service, account, context, signal);
      this.assertCurrent(service, account);
      client = new McpClient(wire, kind => {
        const live = this.live.get(record.connectionId);
        if (!live) return;
        live.catalog = null; live.generation++;
        if (kind === 'disconnected' && live.record.state === 'connected') {
          live.record = { ...live.record, state: 'disconnected', revision: live.record.revision + 1, updatedAt: this.now() };
          this.save(live.record, live.record.revision - 1);
        }
      });
      this.live.set(record.connectionId, { client, record, catalog: null, generation: 0 });
      await client.connect(signal);
      const generation = this.live.get(record.connectionId)!.generation;
      const catalog = await client.discover({ serviceId, accountId, accountRevision: account.revision, configVersion: service.configVersion }, this.now(), signal);
      this.assertCurrent(service, account);
      if (this.live.get(record.connectionId)!.generation !== generation) throw new McpError('catalog-changed', 'MCP 目录发现期间发生变化。');
      const connected: McpConnection = { ...record, revision: 2, state: 'connected', protocolVersion: client.protocolVersion,
        capabilities: client.negotiatedCapabilities, updatedAt: this.now() };
      this.repository.commit(`mcp-discover:${record.connectionId}`, mcpFingerprint(catalog), this.now(), tx => {
        tx.put('catalog', catalog, 0); tx.put('connection', connected, 1);
      });
      this.live.set(record.connectionId, { client, record: connected, catalog, generation });
      return { connection: connected, catalog };
    } catch (error) {
      let stopped = client === null;
      if (client) { try { await client.close(); stopped = true; } catch { /* 保留活跃记录，不能伪造停止。 */ } }
      const failed: McpConnection = { ...record, revision: 2, state: 'failed', errorCode: error instanceof McpError ? error.code : 'connection-failed', updatedAt: this.now() };
      this.save(failed, 1);
      if (stopped) this.live.delete(record.connectionId);
      else if (client) this.live.set(record.connectionId, { client, record: failed, catalog: null, generation: 0 });
      throw error instanceof McpError ? error : new McpError('connection-failed', 'MCP 连接或目录发现失败。');
    }
  }
  get(connectionId: string, sessionId: string): { client: McpClient; connection: McpConnection; catalog: McpCatalog } {
    const live = this.live.get(connectionId);
    if (!live || live.record.sessionId !== sessionId || live.record.state !== 'connected') throw new McpError('connection-failed', 'MCP 连接不可用，请重新验证连接。');
    const { service, account } = this.current(live.record.serviceId, live.record.accountId);
    if (service.configVersion !== live.record.configVersion || account.revision !== live.record.accountRevision) throw new McpError('identity-changed', 'MCP 连接适用身份已变化。');
    if (!live.catalog) throw new McpError('catalog-changed', 'MCP 目录已变化，请重新发现并核对分类。');
    return { client: live.client, connection: live.record, catalog: live.catalog };
  }
  /** 无独立 GET 事件流时，发送/调用前重新发现，不能把缓存目录当作最新事实。 */
  async refresh(connectionId: string, sessionId: string, signal?: AbortSignal): Promise<McpCatalog> {
    const live = this.live.get(connectionId);
    if (!live || live.record.sessionId !== sessionId || live.record.state !== 'connected') throw new McpError('connection-failed', 'MCP 连接不可用。');
    const { service, account } = this.current(live.record.serviceId, live.record.accountId);
    if (service.configVersion !== live.record.configVersion || account.revision !== live.record.accountRevision) throw new McpError('identity-changed', 'MCP 连接身份变化。');
    const generation = live.generation;
    const catalog = await live.client.discover({ serviceId: service.serviceId, accountId: account.accountId, accountRevision: account.revision, configVersion: service.configVersion }, this.now(), signal);
    this.assertCurrent(service, account);
    if (live.generation !== generation || live.record.state !== 'connected') throw new McpError('catalog-changed', 'MCP 目录发现期间发生变化。');
    this.repository.commit(`mcp-catalog:${catalog.catalogId}`, mcpFingerprint(catalog), this.now(), tx => tx.put('catalog', catalog, 0));
    live.catalog = catalog; return catalog;
  }
  async close(connectionId: string): Promise<void> {
    const live = this.live.get(connectionId);
    if (!live) throw new McpError('connection-failed', '没有可核对的 MCP 活跃连接。');
    if (live.record.state !== 'closing') {
      live.record = { ...live.record, revision: live.record.revision + 1, state: 'closing', updatedAt: this.now() };
      this.save(live.record, live.record.revision - 1);
    }
    await live.client.close();
    live.record = { ...live.record, revision: live.record.revision + 1, state: 'closed', updatedAt: this.now() };
    this.save(live.record, live.record.revision - 1); this.live.delete(connectionId);
  }
  async closeSession(sessionId: string): Promise<void> {
    const results = await Promise.allSettled([...this.live.values()].filter(live => live.record.sessionId === sessionId).map(live => this.close(live.record.connectionId)));
    if (results.some(result => result.status === 'rejected')) throw new McpError('result-unknown', '尚有 MCP 连接未证明关闭。');
  }
  stopped(sessionId: string): boolean { return ![...this.live.values()].some(live => live.record.sessionId === sessionId); }
  private current(serviceId: string, accountId: string): { service: McpService; account: McpAccount } {
    const service = this.repository.get('service', serviceId), account = this.repository.get('account', accountId);
    if (!service || service.removed || !service.enabled) throw new McpError('rule-denied', 'MCP 服务未启用或已移除。');
    if (!account || account.serviceId !== serviceId || account.state !== 'ready') throw new McpError('credential-unavailable', 'MCP 账号不可用。');
    return { service, account };
  }
  private assertCurrent(service: McpService, account: McpAccount): void {
    const current = this.current(service.serviceId, account.accountId);
    if (current.service.revision !== service.revision || current.account.revision !== account.revision) throw new McpError('identity-changed', 'MCP 连接期间配置或账号发生变化。');
  }
  private save(record: McpConnection, expected: number): void {
    this.repository.commit(`connection:${record.connectionId}:${record.revision}`, mcpFingerprint(record), this.now(), tx => tx.put('connection', record, expected));
  }
}
