import type { McpAccount, McpAvailability, McpCatalog, McpConnection, McpImportPreview, McpRuleTarget, McpScopeEntry, McpService, McpTransport } from '@multivac/contracts';
import { McpTransportSchema } from '@multivac/contracts';
import { Check } from 'typebox/value';
import { McpError, mcpFingerprint, validateMcpTransport, type McpFactKind, type McpFacts, type McpRepository } from '../modules/mcp/mcp.js';
import { McpRules, McpRuleService, type McpRuleOwnerPolicy } from '../modules/mcp/rules.js';
import type { McpAccountService } from './mcp-account-service.js';
import type { McpExecutionHost, McpExecutionService } from './mcp-execution-service.js';

export interface McpImportInput { commandId: string; config: string; source: string; serviceId?: string; revision?: number }
export interface McpConnectInput { commandId: string; serviceId: string; accountId: string; sessionId: string; fingerprint: string }
/** 纯管理端口；导入预览不读取来源路径、不启动进程、不登录，也不取得工具执行许可。 */
export class McpManagementService {
  readonly rules: McpRuleService;
  constructor(private readonly repository: McpRepository, readonly accounts: McpAccountService, readonly execution: McpExecutionService,
    private readonly host: McpExecutionHost, private readonly owners: McpRuleOwnerPolicy, private readonly changed: (serviceId: string) => void,
    private readonly now = () => new Date().toISOString()) { this.rules = new McpRuleService(repository, owners, now); }
  list(offset = 0, limit = 100) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new McpError('invalid-config', 'MCP 分页无效。', 400);
    const services = this.all('service');
    return { services: services.slice(offset, offset + limit), total: services.length, nextOffset: offset + limit < services.length ? offset + limit : null };
  }
  detail(id: string) {
    const service = this.service(id, true), accounts = this.all('account').filter(value => value.serviceId === id);
    const catalogs = accounts.flatMap(account => {
      const latest = this.all('catalog').filter(value => value.serviceId === id && value.accountId === account.accountId)
        .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt) || b.catalogId.localeCompare(a.catalogId))[0];
      return latest ? [{ catalog: latest, current: latest.accountRevision === account.revision && latest.configVersion === service.configVersion }] : [];
    });
    const connections = this.all('connection').filter(value => value.serviceId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50)
      .map(connection => { try { this.execution.connections.get(connection.connectionId, connection.sessionId); return { connection, usable: true }; } catch { return { connection, usable: false }; } });
    return { service, accounts, catalogs, connections, rules: this.all('rule').filter(value => value.serviceId === id),
      classifications: this.all('classification').filter(value => value.serviceId === id),
      calls: this.all('call').filter(value => value.identity.serviceId === id).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, 25).map(value => ({ ...value, resultText: null })) };
  }
  preview(input: McpImportInput): McpImportPreview[] {
    const entries = parseMcpConfig(input.config);
    if (input.serviceId && (entries.length !== 1 || !input.revision)) throw new McpError('invalid-config', '修改配置需要唯一服务和当前版本。', 400);
    if (input.serviceId && this.service(input.serviceId).revision !== input.revision) throw new McpError('conflict', 'MCP 服务已变化，请保留输入并核对最新版本。');
    const fingerprint = mcpFingerprint({ entries, source: input.source, serviceId: input.serviceId ?? null, revision: input.revision ?? null });
    const old = this.repository.receipt(`mcp-import-preview:${input.commandId}`, fingerprint);
    if (old) return old.changes.map(value => this.repository.get('importPreview', value.id)!);
    const previews = entries.map((entry, index): McpImportPreview => ({ previewId: mcpFingerprint(['import', input.commandId, index]), revision: 1,
      ...entry, source: input.source, existingServiceId: input.serviceId ?? null, expectedServiceRevision: input.revision ?? null,
      configVersion: mcpFingerprint(entry.transport), createdAt: this.now(), expiresAt: new Date(Date.parse(this.now()) + 15 * 60_000).toISOString() }));
    this.repository.commit(`mcp-import-preview:${input.commandId}`, fingerprint, this.now(), tx => { for (const preview of previews) tx.put('importPreview', preview, 0); });
    return previews;
  }
  async confirm(commandId: string, previewId: string): Promise<McpService> {
    const fingerprint = mcpFingerprint({ previewId }), previous = this.repository.receipt(`mcp-import-confirm:${commandId}`, fingerprint);
    if (previous) return this.repository.get('service', previous.changes[0]!.id)!;
    const preview = this.repository.get('importPreview', previewId);
    if (!preview || preview.expiresAt <= this.now()) throw new McpError('conflict', 'MCP 导入预览已过期，请重新预览。');
    const serviceId = preview.existingServiceId ?? mcpFingerprint(['service', preview.previewId]);
    this.repository.commit(`mcp-import-confirm:${commandId}`, fingerprint, this.now(), tx => {
      const old = tx.get('service', serviceId);
      if (preview.existingServiceId && (!old || old.removed || old.revision !== preview.expectedServiceRevision)) throw new McpError('conflict', 'MCP 服务版本已变化，未覆盖修改。');
      tx.put('service', { serviceId, revision: (old?.revision ?? 0) + 1, name: preview.name, source: preview.source, transport: preview.transport,
        configVersion: preview.configVersion, enabled: false, removed: false, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now() }, preview.expectedServiceRevision ?? 0);
    });
    this.changed(serviceId); await this.execution.connections.closeService(serviceId); return this.service(serviceId);
  }
  async state(commandId: string, serviceId: string, revision: number, action: 'enable' | 'disable' | 'remove'): Promise<McpService> {
    const key = `mcp-state:${commandId}`, fingerprint = mcpFingerprint({ serviceId, revision, action });
    if (this.repository.receipt(key, fingerprint)) return this.repository.get('service', serviceId)!;
    this.repository.commit(key, fingerprint, this.now(), tx => {
      const service = tx.get('service', serviceId);
      if (!service || service.removed || service.revision !== revision) throw new McpError('conflict', 'MCP 服务已变化。');
      tx.put('service', { ...service, revision: revision + 1, enabled: action === 'enable', removed: action === 'remove', updatedAt: this.now() }, revision);
    });
    this.changed(serviceId);
    // 停用先落账阻止新调用，清理只结束既有连接，不重新执行工具。清理失败保留真实记录。
    if (action !== 'enable') await this.execution.connections.closeService(serviceId);
    return this.repository.get('service', serviceId)!;
  }
  connectionPreview(serviceId: string, accountId: string, sessionId: string) {
    const service = this.service(serviceId), account = this.repository.get('account', accountId), context = this.host.context(sessionId, null);
    if (!account || account.serviceId !== serviceId) throw new McpError('identity-changed', 'MCP 账号不属于此服务。');
    const effective = new McpRules(this.repository).resolve(serviceId, { ...context, accountId, transportAllowed: this.host.transport(service, context) });
    const evidence = { serviceId, serviceRevision: service.revision, source: service.source, configVersion: service.configVersion, transport: service.transport,
      accountId, accountRevision: account.revision, accountLabel: account.label, sessionId, projectId: context.projectId,
      workingDirectory: context.workingDirectory, host: context.host, runId: context.runId, ruleVersions: effective.ruleVersions };
    return { ...evidence, fingerprint: mcpFingerprint(evidence), available: effective.available, reasons: effective.details };
  }
  async connect(input: McpConnectInput) {
    const fingerprint = mcpFingerprint(input), command = `mcp-connect:${input.commandId}`, connectionId = mcpFingerprint(['connection', input.commandId]);
    if (this.repository.receipt(command, fingerprint)) return this.connectionResult(connectionId);
    const preview = this.connectionPreview(input.serviceId, input.accountId, input.sessionId);
    if (preview.fingerprint !== input.fingerprint || !preview.available) throw new McpError('identity-changed', preview.reasons.join('；') || 'MCP 连接预览已变化，请重新核对。');
    if (this.execution.connections.active(input.sessionId).some(value => value.serviceId === input.serviceId)) throw new McpError('conflict', '请先断开本会话的旧服务连接。');
    this.repository.commit(command, fingerprint, this.now(), () => {});
    const attempt = this.execution.connections.connect(input.serviceId, input.accountId, { sessionId: input.sessionId, host: preview.host }, undefined, connectionId);
    this.changed(input.serviceId);
    try { await attempt; }
    finally { this.changed(input.serviceId); }
    return this.connectionResult(connectionId);
  }
  async disconnect(commandId: string, connectionId: string): Promise<McpConnection> {
    const connection = this.repository.get('connection', connectionId);
    if (!connection) throw new McpError('not-found', 'MCP 连接不存在。', 404);
    const fingerprint = mcpFingerprint({ connectionId }), key = `mcp-disconnect:${commandId}`;
    if (this.repository.receipt(key, fingerprint)) return this.repository.get('connection', connectionId)!;
    this.repository.commit(key, fingerprint, this.now(), () => {});
    await this.execution.connections.close(connectionId);
    this.changed(connection.serviceId); return this.repository.get('connection', connectionId)!;
  }
  async refresh(commandId: string, connectionId: string): Promise<McpCatalog | null> {
    const connection = this.repository.get('connection', connectionId);
    if (!connection) throw new McpError('not-found', 'MCP 连接不存在。', 404);
    const key = `mcp-refresh:${commandId}`, fingerprint = mcpFingerprint({ connectionId });
    if (this.repository.receipt(key, fingerprint)) return this.connectionResult(connectionId).catalog;
    this.repository.commit(key, fingerprint, this.now(), () => {});
    const catalog = await this.execution.connections.refresh(connectionId, connection.sessionId);
    this.changed(connection.serviceId); return catalog;
  }
  availability(serviceId: string, sessionId: string): McpAvailability {
    const context = this.host.context(sessionId, null), service = this.service(serviceId), live = this.execution.connections.active(sessionId).filter(value => value.serviceId === serviceId);
    return new McpRules(this.repository).resolve(serviceId, { ...context, accountId: live.length === 1 ? live[0]!.accountId : null, transportAllowed: this.host.transport(service, context) });
  }
  connectResult(commandId: string) { return this.connectionResult(mcpFingerprint(['connection', commandId])); }
  connectionResult(connectionId: string): { connection: McpConnection | null; catalog: McpCatalog | null } {
    const connection = this.repository.get('connection', connectionId);
    try { return { connection, catalog: connection ? this.execution.connections.get(connectionId, connection.sessionId).catalog : null }; }
    catch { return { connection, catalog: null }; }
  }
  scope(kind: McpRuleTarget['kind'], id: string): McpScopeEntry[] {
    const target: McpRuleTarget = kind === 'project' ? { kind, projectId: id, excluded: false, accountId: null }
      : kind === 'agent' ? { kind, agentId: id, preferred: false, effectCeiling: [] } : { kind, sessionId: id, disabled: false };
    this.owners.validate(target, true);
    let editable = true; try { this.owners.validate(target); } catch { editable = false; }
    const accounts = this.all('account');
    return this.all('service').filter(service => !service.removed).map(service => {
      let availability: McpAvailability | null = null, reason: string | null = null;
      if (kind === 'session') { try { availability = this.availability(service.serviceId, id); } catch (error) { reason = error instanceof McpError ? error.message : '当前宿主无法提供有效能力。'; } }
      return { service, accounts: accounts.filter(account => account.serviceId === service.serviceId), rule: this.rules.get(service.serviceId, target), availability, reason, editable };
    });
  }
  call(callId: string) { const call = this.repository.get('call', callId); if (!call) throw new McpError('not-found', 'MCP 调用不存在。', 404); return call; }
  notify(serviceId: string): void { this.changed(serviceId); }
  private service(id: string, includeRemoved = false): McpService { const value = this.repository.get('service', id); if (!value || value.removed && !includeRemoved) throw new McpError('not-found', 'MCP 服务不存在。', 404); return value; }
  private all<K extends McpFactKind>(kind: K): McpFacts[K][] {
    const result: McpFacts[K][] = [];
    for (let offset = 0; ; offset += 100) { const page = this.repository.list(kind, { offset }); result.push(...page); if (page.length < 100) return result; }
  }
}

/** 接受用户显式粘贴/上传的标准 JSON 或本产品公开配置；不自动读取其他应用目录。 */
export function parseMcpConfig(config: string): { name: string; transport: McpTransport }[] {
  if (Buffer.byteLength(config) > 256_000) throw new McpError('limit-exceeded', 'MCP 配置超过上限。', 413);
  let value: unknown;
  try { value = JSON.parse(config); } catch { throw new McpError('invalid-config', 'MCP 配置不是有效 JSON。', 400); }
  const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('invalid-config', 'MCP 配置应为对象。', 400); return value as Record<string, unknown>; };
  const root = object(value);
  let entries: { name: string; transport: McpTransport }[];
  if (Object.hasOwn(root, 'mcpServers')) {
    if (Object.keys(root).some(key => key !== 'mcpServers')) throw new McpError('invalid-config', '仅导入 mcpServers，请移除其他配置。', 400);
    entries = Object.entries(object(root.mcpServers)).map(([name, raw]) => {
      const item = object(raw);
      if (item.environmentKeys !== undefined && !Array.isArray(item.environmentKeys)) throw new McpError('invalid-config', '私有环境变量名称必须为数组。', 400);
      if (Object.keys(item).some(key => !['command', 'args', 'cwd', 'environmentKeys', 'env', 'url', 'type'].includes(key))
        || item.env !== undefined && Object.values(object(item.env)).some(value => value !== '')) throw new McpError('invalid-config', '配置含不支持字段或私有值；请将秘密移到独立账号配置，env 仅可保留空占位。', 400);
      if (item.url !== undefined) {
        if (item.command !== undefined || item.args !== undefined || item.env !== undefined || item.cwd !== undefined || item.environmentKeys !== undefined || !['http', 'streamable-http', 'sse', undefined].includes(item.type as string | undefined)) throw new McpError('invalid-config', '远程 MCP 配置字段冲突。', 400);
        return { name, transport: { kind: item.type === 'sse' ? 'legacy-sse' : 'streamable-http', url: item.url } as McpTransport };
      }
      if (item.type !== undefined && item.type !== 'stdio') throw new McpError('invalid-config', 'MCP 传输类型不受支持。', 400);
      return { name, transport: { kind: 'stdio', command: item.command, args: item.args ?? [], cwd: item.cwd ?? null,
        environmentKeys: [...new Set([...(Array.isArray(item.environmentKeys) ? item.environmentKeys : []), ...Object.keys(item.env === undefined ? {} : object(item.env))])] } as McpTransport };
    });
  } else {
    if (Object.keys(root).some(key => !['name', 'transport'].includes(key))) throw new McpError('invalid-config', 'MCP 公开配置只接受 name 和 transport。', 400);
    entries = [{ name: root.name as string, transport: root.transport as McpTransport }];
  }
  if (!entries.length || entries.length > 50) throw new McpError('invalid-config', '一次导入 1–50 个服务。', 400);
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 128 || !Check(McpTransportSchema, entry.transport)) throw new McpError('invalid-config', 'MCP 名称或传输配置无效。', 400);
    validateMcpTransport(entry.transport);
    if (entry.transport.kind === 'stdio' && [entry.transport.command, ...entry.transport.args].some(value => /(?:--(?:token|password|secret|api[-_]?key|header)(?:=|$)|(?:token|password|secret|authorization|api[-_]?key)\s*[=:]|Bearer\s|sk-[A-Za-z0-9]{16,})/iu.test(value)))
      throw new McpError('invalid-config', '公开启动参数疑似包含凭据，请改用账号私有环境变量。', 400);
  }
  return entries;
}
