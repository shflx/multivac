import type { McpCall, McpCatalog, McpEffect, McpJson, McpOperationIdentity, McpService, McpTool } from '@multivac/contracts';
import { McpAuthorizationService, type McpOperationPolicy } from './mcp-authorization-service.js';
import { McpConnections } from '../modules/mcp/connections.js';
import { McpRules, type McpRuleContext } from '../modules/mcp/rules.js';
import { McpError, mcpCanonical, mcpFingerprint, type McpRepository } from '../modules/mcp/mcp.js';
import { validateMcpArguments } from '../modules/mcp/arguments.js';

export interface McpExecutionHost {
  context(sessionId: string, commandId: string | null): McpRuleContext & { workingDirectory: string };
  transport(service: McpService, context: ReturnType<McpExecutionHost['context']>): boolean;
  lease(sessionId: string, phase: 'starting' | 'settled', marker: string, bytes: number): number;
  redactor(accountId: string, revision: number): Promise<(text: string) => string>;
}
interface Capability { capabilityId: string; identity: McpOperationIdentity; tool: McpTool; connectionId: string | null; preferred: boolean }

/** 公共工具端口；两个 harness 均只依赖同一个发现/调用入口，不取得授权决定方法。 */
export class McpExecutionService implements McpOperationPolicy {
  private readonly turns = new Map<string, Capability[]>();
  private readonly opening = new Map<string, Promise<string>>();
  private readonly pending = new Map<string, { sessionId: string; fingerprint: string; controller: AbortController; promise: Promise<McpCall> }>();
  readonly authorizations: McpAuthorizationService;
  constructor(private readonly repository: McpRepository, readonly connections: McpConnections, private readonly host: McpExecutionHost,
    changed: (id: string) => void = () => {}, private readonly now = () => new Date().toISOString()) {
    this.authorizations = new McpAuthorizationService(repository, this, changed);
  }
  /** 发送时固定已发现的配置/账号/目录/工具及规则，之后目录刷新不得替换本轮身份。 */
  prepare(sessionId: string, commandId: string): void {
    const key = this.key(sessionId, commandId);
    if (this.turns.has(key)) return;
    const context = this.host.context(sessionId, commandId), capabilities: Capability[] = [];
    for (const service of this.all('service')) {
      const active = this.connections.active(sessionId).filter(connection => connection.serviceId === service.serviceId);
      const actual = { ...context, accountId: active.length === 1 ? active[0]!.accountId : null, transportAllowed: this.host.transport(service, context) };
      const effective = new McpRules(this.repository).resolve(service.serviceId, actual);
      if (!effective.available || !effective.accountId) continue;
      const account = this.repository.get('account', effective.accountId)!;
      const catalog = this.all('catalog').filter(value => value.serviceId === service.serviceId && value.accountId === account.accountId
        && value.accountRevision === account.revision && value.configVersion === service.configVersion)
        .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt) || b.catalogId.localeCompare(a.catalogId))[0];
      if (!catalog) continue;
      for (const tool of catalog.tools) {
        const identity: McpOperationIdentity = { serviceId: service.serviceId, serviceRevision: service.revision, configVersion: service.configVersion,
          accountId: account.accountId, accountRevision: account.revision, catalogVersion: catalog.version, toolId: tool.toolId,
          definitionVersion: tool.definitionVersion, sessionId, projectId: context.projectId, workingDirectory: context.workingDirectory,
          commandId, toolCallId: 'candidate', taskId: context.taskId, runId: context.runId, agentId: context.agentId, host: context.host, ruleVersions: effective.ruleVersions };
        try {
          const effects = this.classified(identity, catalog);
          new McpRules(this.repository).assert(identity, actual, effects);
          capabilities.push({ capabilityId: mcpFingerprint(identity), identity, tool, preferred: effective.preferred, connectionId: active.find(value => value.accountId === account.accountId)?.connectionId ?? null });
        } catch (error) { if (!(error instanceof McpError)) throw error; }
      }
    }
    this.turns.set(key, capabilities.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.tool.name.localeCompare(b.tool.name) || a.tool.toolId.localeCompare(b.tool.toolId)));
  }
  list(sessionId: string, commandId: string | null) {
    const capabilities = commandId ? this.turns.get(this.key(sessionId, commandId)) ?? [] : [];
    return capabilities.flatMap(value => {
      try {
        const effects = this.classified(value.identity); this.assertSnapshot(value.identity, effects);
        if (value.connectionId) this.connection(value);
        return [{ capabilityId: value.capabilityId, serviceId: value.identity.serviceId, toolId: value.tool.toolId, preferred: value.preferred,
          name: value.tool.name, description: value.tool.description, inputSchema: value.tool.inputSchema, definitionVersion: value.identity.definitionVersion,
          catalogVersion: value.identity.catalogVersion, effects, ruleVersions: value.identity.ruleVersions }];
      } catch (error) { if (error instanceof McpError) return []; throw error; }
    });
  }
  invoke(sessionId: string, commandId: string | null, toolCallId: string, capabilityId: string, args: Record<string, McpJson>, signal: AbortSignal): Promise<McpCall> {
    args = structuredClone(args);
    const id = mcpFingerprint([sessionId, toolCallId]), fingerprint = mcpFingerprint({ commandId, capabilityId, args }), old = this.pending.get(id);
    if (old) {
      if (old.fingerprint !== fingerprint) return Promise.reject(new McpError('conflict', '同一在途 MCP 调用的参数不一致。'));
      return old.promise;
    }
    const controller = new AbortController();
    const promise = this.perform(sessionId, commandId, toolCallId, capabilityId, args, AbortSignal.any([signal, controller.signal])).finally(() => this.pending.delete(id));
    this.pending.set(id, { sessionId, fingerprint, controller, promise });
    return promise;
  }
  private async perform(sessionId: string, commandId: string | null, toolCallId: string, capabilityId: string, args: Record<string, McpJson>, signal: AbortSignal): Promise<McpCall> {
    const capability = commandId ? this.turns.get(this.key(sessionId, commandId))?.find(value => value.capabilityId === capabilityId) : null;
    if (!capability) throw new McpError('identity-changed', '该 MCP 工具未在本轮发送时开放，请重新发送并查询能力。');
    const identity = { ...capability.identity, toolCallId }, callId = mcpFingerprint([sessionId, toolCallId]), fingerprint = mcpFingerprint(args);
    const old = this.repository.get('call', callId);
    if (old) {
      if (old.argumentsFingerprint !== fingerprint || mcpCanonical(old.identity) !== mcpCanonical(identity)) throw new McpError('conflict', '同一 MCP 调用的参数或身份不一致。');
      return old;
    }
    if (signal.aborted) throw new McpError('cancelled', '本轮已停止，MCP 调用尚未执行。');
    // 建连仅使用用户已选择的账号与宿主隔离；不调用第三方工具，不扩大路径、网络或派生进程权限。
    this.assertSnapshot(identity, this.classified(identity));
    validateMcpArguments(capability.tool.inputSchema, args);
    await this.ensureConnection(capability, signal);
    const request = await this.authorizations.request(identity, args);
    let call: McpCall = { callId, revision: 1, identity, argumentsFingerprint: fingerprint, authorizationId: request.requestId,
      state: 'prepared', errorCode: null, startedAt: null, finishedAt: null, resultRef: null, resultText: null };
    this.save(call, 0);
    const controller = new AbortController();
    const abort = () => { controller.abort(); const current = this.repository.get('call', callId)!;
      if (current.state === 'running') this.save({ ...current, revision: current.revision + 1, state: 'cancel-requested' }, current.revision); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    let leased = false, outputBytes = 0;
    try {
      const decision = await this.authorizations.wait(request.requestId, controller.signal);
      if (decision.status !== 'allowed' || controller.signal.aborted) throw new McpError('authorization-invalid', `MCP 许可已${decision.status}，未执行。`);
      await this.authorizations.authorize(request.requestId, identity, args);
      if (controller.signal.aborted) throw new McpError('cancelled', 'MCP 调用尚未执行，已取消。');
      const redact = await this.host.redactor(identity.accountId, identity.accountRevision);
      const result = await this.connection(capability).client.rpc('tools/call', { name: capability.tool.name, arguments: args }, controller.signal, () => {
        // 凭据和传输准备可能等待；真正发送前同步复核并登记，拒绝仍属于未开始。
        this.authorizations.assertAuthorized(request.requestId, identity, args);
        this.assertSnapshot(identity, this.classified(identity));
        if (controller.signal.aborted) throw new McpError('cancelled', 'MCP 调用尚未发送，已取消。');
        this.host.lease(sessionId, 'starting', callId, Buffer.byteLength(mcpCanonical(args))); leased = true;
        call = { ...call, revision: call.revision + 1, state: 'running', startedAt: this.now() }; this.save(call, call.revision - 1);
      });
      const normalized = this.result(result, capability.tool); outputBytes = Buffer.byteLength(normalized.text);
      const text = redact(normalized.text).slice(0, 16000);
      const current = this.repository.get('call', callId)!;
      call = { ...current, revision: current.revision + 1, state: normalized.error ? 'failed' : 'succeeded', errorCode: normalized.error ? 'connection-failed' : null,
        resultText: text, resultRef: callId, finishedAt: this.now() }; this.save(call, current.revision);
      // 在途撤销不能声称远端停止；结果已入账，但失效身份不得把内容再交给模型。
      await this.authorizations.authorize(request.requestId, identity, args);
      if (controller.signal.aborted) throw new McpError('cancelled', '调用已结束，本轮已停止；结果保留供用户核对。');
      return call;
    } catch (error) {
      const current = this.repository.get('call', callId)!;
      if (current.state === 'prepared' || current.state === 'running' || current.state === 'cancel-requested') {
        const state = current.state === 'prepared' ? 'cancelled' : 'unknown';
        call = { ...current, revision: current.revision + 1, state, errorCode: state === 'unknown' ? 'result-unknown' : error instanceof McpError ? error.code : 'connection-failed', finishedAt: this.now() };
        this.save(call, current.revision);
      }
      throw error instanceof McpError ? error : new McpError('result-unknown', 'MCP 结果待核对，请勿自动重试。');
    } finally {
      signal.removeEventListener('abort', abort);
      if (leased) this.host.lease(sessionId, 'settled', callId, outputBytes);
    }
  }
  async verify(identity: McpOperationIdentity, _args: Record<string, McpJson>, effects: McpEffect[]): Promise<void> {
    const capability = this.turns.get(this.key(identity.sessionId, identity.commandId))?.find(value => value.identity.toolId === identity.toolId && value.identity.accountId === identity.accountId);
    if (!capability) throw new McpError('identity-changed', 'MCP 本轮能力快照已失效。');
    this.assertSnapshot(identity, effects);
    await this.connections.refresh(this.connection(capability).connection.connectionId, identity.sessionId);
    this.catalog(identity); this.assertSnapshot(identity, effects);
  }
  userIdentity(sessionId: string, connectionId: string, toolId: string): McpOperationIdentity {
    const { connection, catalog } = this.connections.get(connectionId, sessionId), context = this.host.context(sessionId, null);
    const service = this.repository.get('service', connection.serviceId)!, tool = catalog.tools.find(value => value.toolId === toolId);
    if (!tool) throw new McpError('not-found', 'MCP 工具不存在。', 404);
    return { serviceId: service.serviceId, serviceRevision: service.revision, configVersion: service.configVersion, accountId: connection.accountId,
      accountRevision: connection.accountRevision, catalogVersion: catalog.version, toolId, definitionVersion: tool.definitionVersion,
      sessionId, projectId: context.projectId, workingDirectory: context.workingDirectory, commandId: 'management', toolCallId: 'classification',
      taskId: context.taskId, runId: context.runId, agentId: context.agentId, host: context.host, ruleVersions: [] };
  }
  catalog(identity: McpOperationIdentity): McpCatalog {
    if (identity.commandId === 'management') {
      const active = this.connections.active(identity.sessionId).filter(value => value.serviceId === identity.serviceId && value.accountId === identity.accountId);
      if (active.length === 1) return this.connections.get(active[0]!.connectionId, identity.sessionId).catalog;
    }
    const capability = this.turns.get(this.key(identity.sessionId, identity.commandId))?.find(value => value.identity.toolId === identity.toolId && value.identity.accountId === identity.accountId);
    if (!capability) throw new McpError('catalog-changed', 'MCP 本轮能力快照不存在。');
    return this.connection(capability).catalog;
  }
  finishTurn(sessionId: string): void {
    this.authorizations.cancelSession(sessionId);
    for (const key of this.turns.keys()) if (key.startsWith(this.key(sessionId, ''))) this.turns.delete(key);
  }
  async cancelSession(sessionId: string): Promise<void> {
    this.authorizations.cancelSession(sessionId);
    const pending = [...this.pending.values()].filter(value => value.sessionId === sessionId);
    for (const call of pending) call.controller.abort();
    await Promise.allSettled(pending.map(call => call.promise));
    await this.connections.closeSession(sessionId);
    for (const key of this.turns.keys()) if (key.startsWith(this.key(sessionId, ''))) this.turns.delete(key);
  }
  recover(): void {
    this.authorizations.invalidatePending();
    for (const call of this.all('call')) if (['prepared', 'running', 'cancel-requested'].includes(call.state))
      this.save({ ...call, revision: call.revision + 1, state: call.state === 'prepared' ? 'cancelled' : 'unknown', errorCode: 'result-unknown', finishedAt: this.now() }, call.revision);
    for (const connection of this.all('connection')) if (!['closed', 'failed', 'disconnected'].includes(connection.state)) {
      const failed = { ...connection, revision: connection.revision + 1, state: 'failed' as const, errorCode: 'result-unknown' as const, updatedAt: this.now() };
      this.repository.commit(`connection-recovery:${connection.connectionId}:${failed.revision}`, mcpFingerprint(failed), this.now(), tx => tx.put('connection', failed, connection.revision));
    }
  }
  stopped(sessionId: string): boolean { return this.connections.stopped(sessionId) && ![...this.pending.values()].some(value => value.sessionId === sessionId); }
  hasActivity(): boolean { return this.connections.sessions().length > 0 || this.pending.size > 0; }
  async close(): Promise<void> { await Promise.all([...new Set([...this.connections.sessions(), ...[...this.pending.values()].map(value => value.sessionId)])].map(id => this.cancelSession(id))); }
  private assertSnapshot(identity: McpOperationIdentity, effects: McpEffect[]): void {
    const context = this.host.context(identity.sessionId, identity.commandId), service = this.repository.get('service', identity.serviceId), account = this.repository.get('account', identity.accountId);
    if (!service || service.revision !== identity.serviceRevision || service.configVersion !== identity.configVersion || !account || account.revision !== identity.accountRevision)
      throw new McpError('identity-changed', 'MCP 服务或账号已变化。');
    if (context.workingDirectory !== identity.workingDirectory) throw new McpError('identity-changed', 'MCP 执行目录已变化。');
    new McpRules(this.repository).assert(identity, { ...context, accountId: identity.accountId, transportAllowed: this.host.transport(service, context) }, effects);
  }
  private connection(capability: Capability) {
    if (!capability.connectionId) throw new McpError('connection-failed', 'MCP 尚未建立本会话连接。');
    return this.connections.get(capability.connectionId, capability.identity.sessionId);
  }
  private async ensureConnection(capability: Capability, signal: AbortSignal): Promise<void> {
    if (capability.connectionId) { this.connection(capability); return; }
    const identity = capability.identity, key = this.key(identity.sessionId, identity.serviceId);
    let opening = this.opening.get(key);
    if (!opening) {
      opening = this.connections.connect(identity.serviceId, identity.accountId, { sessionId: identity.sessionId, host: identity.host }, signal).then(value => value.connection.connectionId);
      this.opening.set(key, opening);
    }
    try {
      const connectionId = await opening;
      for (const candidates of this.turns.values()) for (const value of candidates) if (value.identity.sessionId === identity.sessionId && value.identity.serviceId === identity.serviceId && value.identity.accountId === identity.accountId) value.connectionId = connectionId;
      if (this.connection(capability).catalog.version !== identity.catalogVersion) throw new McpError('catalog-changed', '连接后的目录版本已变化，请重新发现并发送。');
    } finally { this.opening.delete(key); }
  }
  private classified(identity: McpOperationIdentity, catalog?: McpCatalog): McpEffect[] {
    // 发送时允许读取已经固定的目录；真实调用与许可始终通过活跃连接的 identity 校验。
    const classifications = this.all('classification').filter(value => !value.revokedAt && value.serviceId === identity.serviceId && value.accountId === identity.accountId
      && value.accountRevision === identity.accountRevision && value.configVersion === identity.configVersion && value.catalogVersion === (catalog?.version ?? identity.catalogVersion)
      && value.toolId === identity.toolId && value.definitionVersion === identity.definitionVersion);
    if (!classifications.length) throw new McpError('classification-required', '工具需要用户确认效果。');
    const effects = new Set(classifications.flatMap(value => value.effects));
    if (this.repository.get('service', identity.serviceId)?.transport.kind === 'streamable-http') effects.add('data-transfer');
    return [...effects].sort();
  }
  private result(value: unknown, tool: McpTool): { text: string; error: boolean } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('unsupported-protocol', 'MCP 已返回，但结果格式无效；不要自动重试。');
    const result = value as Record<string, unknown>;
    if (!Array.isArray(result.content)) throw new McpError('unsupported-protocol', 'MCP 已返回，但缺少 content；不要自动重试。');
    if (tool.outputSchema && !result.isError) validateMcpArguments(tool.outputSchema, result.structuredContent);
    let unsupported = false;
    const parts = result.content.map(item => {
      if (!item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string') { unsupported = true; return ''; }
      return item.text as string;
    });
    let text = parts.join('\n');
    if (result.structuredContent !== undefined) text += '\n' + mcpCanonical(result.structuredContent);
    if (unsupported) text += '\n[结果含当前不支持的非文本内容，未送入模型。]';
    if (text.length > 15000) text = text.slice(0, 15000) + '\n[内容已截断]';
    return { text, error: result.isError === true };
  }
  private all<K extends import('../modules/mcp/mcp.js').McpFactKind>(kind: K): import('../modules/mcp/mcp.js').McpFacts[K][] {
    const all: import('../modules/mcp/mcp.js').McpFacts[K][] = [];
    for (let offset = 0; ; offset += 100) { const page = this.repository.list(kind, { offset }); all.push(...page); if (page.length < 100) return all; }
  }
  private save(call: McpCall, expected: number): void { this.repository.commit(`mcp-call:${call.callId}:${call.revision}`, mcpFingerprint(call), this.now(), tx => tx.put('call', call, expected)); }
  private key(sessionId: string, id: string): string { return `${sessionId.length}:${sessionId}:${id}`; }
}
