import { randomUUID } from 'node:crypto';
import type { McpAuthorization, McpCatalog, McpClassification, McpEffect, McpJson, McpOperationIdentity } from '@multivac/contracts';
import { McpError, mcpCanonical, mcpFingerprint, type McpRepository } from '../modules/mcp/mcp.js';
import { validateMcpArguments } from '../modules/mcp/arguments.js';

export interface McpOperationPolicy {
  /** 由会话/运行事实解析，必须复核原宿主权限、有效规则及实际参数。 */
  verify(identity: McpOperationIdentity, args: Record<string, McpJson>, effects: McpEffect[]): Promise<void>;
  /** 活跃连接的真实目录；目录通知失效时必须抛错，不能用旧快照冒充当前目录。 */
  catalog(identity: McpOperationIdentity): McpCatalog;
  /** 未分类工具能否以“首次调用时确认”进入许可：仅宿主与智能体上限覆盖全部效果时成立。 */
  allowsUnclassified(identity: McpOperationIdentity): boolean;
}
const ALL_EFFECTS: McpEffect[] = ['read', 'local-write', 'external-write', 'data-transfer'];

/** 按服务注解预选效果：只作提示，用户确认后才成为分类。 */
function suggestEffects(tool: McpCatalog['tools'][number]): McpEffect[] {
  const annotations = tool.annotations as { readOnlyHint?: unknown } | null;
  return annotations && typeof annotations === 'object' && annotations.readOnlyHint === true ? ['read'] : [];
}
/** Agent 仅拿到 request/inspect；decide 和 confirmClassification 只装配到用户决定入口。 */
export class McpAuthorizationService {
  private readonly waits = new Map<string, Set<(request: McpAuthorization) => void>>();
  wait(id: string, signal: AbortSignal): Promise<McpAuthorization> {
    const current = this.get(id);
    if (current.status !== 'pending') return Promise.resolve(current);
    return new Promise(resolve => {
      const finish = (request: McpAuthorization) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        this.waits.get(id)?.delete(finish); if (!this.waits.get(id)?.size) this.waits.delete(id);
        resolve(request);
      };
      const abort = () => { const value = this.get(id); if (value.status === 'pending') this.terminal(value, 'cancelled'); else finish(value); };
      const timer = setTimeout(() => { const value = this.get(id); if (value.status === 'pending') this.terminal(value, 'expired'); else finish(value); }, Math.max(1, Date.parse(current.expiresAt) - this.now()));
      const listeners = this.waits.get(id) ?? new Set(); listeners.add(finish); this.waits.set(id, listeners);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (this.get(id).status !== 'pending') finish(this.get(id));
    });
  }
  private notify(id: string): void { this.changed(id); const request = this.get(id); if (request.status !== 'pending') for (const finish of [...this.waits.get(id) ?? []]) finish(request); }
  constructor(private readonly repository: McpRepository, private readonly policy: McpOperationPolicy,
    private readonly changed: (id: string) => void = () => {}, private readonly now = () => Date.now()) {}
  all(): McpAuthorization[] {
    const all: McpAuthorization[] = [];
    for (let offset = 0; ; offset += 100) { const page = this.repository.list('authorization', { offset }); all.push(...page); if (page.length < 100) return all; }
  }
  isExpired(request: McpAuthorization): boolean { return Date.parse(request.expiresAt) <= this.now(); }
  get(id: string): McpAuthorization {
    const value = this.repository.get('authorization', id);
    if (!value) throw new McpError('not-found', 'MCP 授权请求不存在。', 404);
    return value;
  }
  confirmClassification(commandId: string, identity: McpOperationIdentity, effects: McpEffect[]): McpClassification {
    const classification = this.classification(commandId, identity, effects);
    this.repository.commit(`classify:${commandId}`, mcpFingerprint({ identity, effects }), this.at(), tx => tx.put('classification', classification, 0));
    return this.repository.get('classification', classification.classificationId)!;
  }
  /** 构造一份用户分类；管理页确认与首次调用许可共用，绑定当前账号、配置、目录与工具定义版本。 */
  private classification(commandId: string, identity: McpOperationIdentity, effects: McpEffect[]): McpClassification {
    const { catalog, tool } = this.identity(identity);
    if (!effects.length || new Set(effects).size !== effects.length || effects.some(effect => !ALL_EFFECTS.includes(effect)))
      throw new McpError('invalid-config', '请明确选择工具的实际效果。', 400);
    return { classificationId: mcpFingerprint(['classification', commandId, identity.serviceId, identity.toolId]), revision: 1, serviceId: identity.serviceId,
      accountId: identity.accountId, accountRevision: identity.accountRevision, configVersion: identity.configVersion, catalogVersion: catalog.version,
      toolId: tool.toolId, definitionVersion: tool.definitionVersion, effects: [...effects].sort(), sourceDecisionId: commandId, confirmedAt: this.at(), revokedAt: null };
  }
  /** 当前适用的效果；尚无分类时返回 null，由调用方决定能否首次调用时确认。 */
  private currentEffects(identity: McpOperationIdentity): McpEffect[] | null {
    try { return this.effects(identity); }
    catch (error) { if (error instanceof McpError && error.code === 'classification-required') return null; throw error; }
  }
  effects(identity: McpOperationIdentity): McpEffect[] {
    this.identity(identity);
    const applicable: McpClassification[] = [];
    for (let offset = 0; ; offset += 100) {
      const records = this.repository.list('classification', { serviceId: identity.serviceId, offset });
      applicable.push(...records.filter(item => !item.revokedAt && item.accountId === identity.accountId && item.accountRevision === identity.accountRevision
        && item.configVersion === identity.configVersion && item.catalogVersion === identity.catalogVersion && item.toolId === identity.toolId && item.definitionVersion === identity.definitionVersion));
      if (records.length < 100) break;
    }
    if (!applicable.length) throw new McpError('classification-required', 'MCP 工具效果尚未由用户确认，或适用版本已变化。');
    // 多份适用分类取效果并集，不能利用较宽松的旧记录降低效果。
    const effects = new Set(applicable.flatMap(item => item.effects));
    const service = this.repository.get('service', identity.serviceId)!;
    if (service.transport.kind === 'streamable-http') effects.add('data-transfer');
    return [...effects].sort();
  }
  async request(identity: McpOperationIdentity, args: Record<string, McpJson>): Promise<McpAuthorization> {
    identity = structuredClone(identity); args = structuredClone(args);
    const classified = this.currentEffects(identity);
    // 未分类工具只在宿主允许全部效果时进入许可，由用户在本次决定中一并确认效果。
    if (!classified && !this.policy.allowsUnclassified(identity)) throw new McpError('classification-required', 'MCP 工具效果尚未由用户确认，或适用版本已变化。');
    const effects = classified ?? [];
    const { tool } = this.identity(identity);
    validateMcpArguments(tool.inputSchema, args);
    await this.policy.verify(identity, args, effects); this.identity(identity);
    if (identity.host === 'coordinator' && effects.some(effect => effect === 'local-write' || effect === 'external-write')) throw new McpError('rule-denied', '全局 Multivac 不开放第三方写工具。');
    const fingerprint = mcpFingerprint({ identity, args, effects, classificationRequired: !classified });
    const commandId = `mcp-permit:${mcpFingerprint([identity.sessionId, identity.toolCallId])}`;
    const old = this.repository.receipt(commandId, fingerprint);
    if (old) return this.get(old.changes[0]!.id);
    const service = this.repository.get('service', identity.serviceId)!, account = this.repository.get('account', identity.accountId)!;
    const request: McpAuthorization = { requestId: randomUUID(), revision: 1, identity, argumentsFingerprint: mcpFingerprint(args), arguments: args,
      operation: { serviceName: service.name, source: service.source, transport: service.transport, accountLabel: account.label, toolName: this.identity(identity).tool.name },
      effects, ...(classified ? {} : { classificationRequired: true, suggestedEffects: suggestEffects(tool) }), status: 'pending', createdAt: this.at(), expiresAt: new Date(this.now() + 10 * 60_000).toISOString(), decidedAt: null, revokedAt: null };
    this.repository.commit(commandId, fingerprint, this.at(), tx => tx.put('authorization', request, 0));
    this.notify(request.requestId); return request;
  }
  async decide(id: string, revision: number, decision: 'once' | 'deny', commandId: string, chosen?: McpEffect[]): Promise<McpAuthorization> {
    const fingerprint = mcpFingerprint({ id, revision, decision, ...(chosen ? { effects: [...chosen].sort() } : {}) });
    const receipt = this.repository.receipt(`mcp-decision:${commandId}`, fingerprint);
    if (receipt) return this.get(id);
    let request = this.get(id);
    if (request.status === 'pending' && Date.parse(request.expiresAt) <= this.now()) return this.terminal(request, 'expired');
    if (request.revision !== revision || request.status !== 'pending') throw new McpError('authorization-invalid', 'MCP 请求版本已变化或已终结。');
    // 首次调用：用户必须同时确认效果；分类与许可在同一次提交中写入。
    const classifying = decision === 'once' && request.classificationRequired && !request.effects.length;
    if (classifying && !chosen?.length) throw new McpError('invalid-config', '首次调用需要确认这个工具的实际效果。', 400);
    let classification: McpClassification | null = null, effects = request.effects;
    if (decision === 'once') {
      try {
        this.assertRequestCurrent(request);
        if (classifying) {
          classification = this.classification(commandId, request.identity, chosen!);
          effects = [...new Set([...classification.effects, ...(request.operation.transport.kind === 'streamable-http' ? ['data-transfer' as const] : [])])].sort();
        }
        await this.policy.verify(request.identity, request.arguments, effects);
        this.assertRequestCurrent(request);
      } catch (error) {
        if (error instanceof McpError && error.code === 'invalid-config') throw error;
        request = this.terminal(request, 'invalidated');
        return request;
      }
    }
    const next: McpAuthorization = { ...request, revision: revision + 1, effects, status: decision === 'once' ? 'allowed' : 'denied', decidedAt: this.at() };
    this.repository.commit(`mcp-decision:${commandId}`, fingerprint, this.at(), tx => {
      if (classification) tx.put('classification', classification, 0);
      tx.put('authorization', next, revision);
    });
    this.notify(id); return next;
  }
  assertAuthorized(id: string, identity: McpOperationIdentity, args: Record<string, McpJson>): void {
    const request = this.get(id);
    if (request.status !== 'allowed' || request.revokedAt !== null || Date.parse(request.expiresAt) <= this.now()
      || mcpCanonical(request.identity) !== mcpCanonical(identity) || request.argumentsFingerprint !== mcpFingerprint(args))
      throw new McpError('authorization-invalid', 'MCP 授权不适用于本次参数、身份或时间。');
    this.assertRequestCurrent(request);
  }
  async authorize(id: string, identity: McpOperationIdentity, args: Record<string, McpJson>): Promise<void> {
    this.assertAuthorized(id, identity, args);
    await this.policy.verify(identity, args, this.get(id).effects);
    this.assertAuthorized(id, identity, args);
  }
  revoke(commandId: string, id: string, revision: number): McpAuthorization {
    this.repository.commit(`mcp-revoke:${commandId}`, mcpFingerprint({ id, revision }), this.at(), tx => {
      const request = tx.get('authorization', id);
      if (!request || request.revision !== revision || request.status !== 'allowed' || request.revokedAt) throw new McpError('conflict', 'MCP 许可已变化或不可撤销。');
      tx.put('authorization', { ...request, revision: revision + 1, revokedAt: this.at() }, revision);
    });
    this.notify(id); return this.get(id);
  }
  revokeClassification(commandId: string, id: string, revision: number): void {
    this.repository.commit(`mcp-classification-revoke:${commandId}`, mcpFingerprint({ id, revision }), this.at(), tx => {
      const classification = tx.get('classification', id);
      if (!classification || classification.revision !== revision || classification.revokedAt) throw new McpError('conflict', 'MCP 分类已变化。');
      tx.put('classification', { ...classification, revision: revision + 1, revokedAt: this.at() }, revision);
    });
  }
  cancelSession(sessionId: string): void {
    for (const request of this.all().filter(item => item.identity.sessionId === sessionId && item.status === 'pending')) this.terminal(request, 'cancelled');
  }
  invalidatePending(): void { for (const request of this.all().filter(item => item.status === 'pending')) this.terminal(request, 'invalidated'); }
  private assertRequestCurrent(request: McpAuthorization): void {
    const current = this.get(request.requestId);
    if (current.revision !== request.revision || current.revokedAt !== null) throw new McpError('authorization-invalid', 'MCP 请求已变化或已撤销。');
    this.identity(request.identity);
    // 待确认分类的请求在决定前效果为空，当前也必须仍未分类；其他请求的效果须与当前分类一致。
    if (Date.parse(request.expiresAt) <= this.now() || mcpCanonical(this.currentEffects(request.identity) ?? []) !== mcpCanonical(request.effects)) throw new McpError('authorization-invalid', 'MCP 请求的分类或时间已失效。');
  }
  private identity(identity: McpOperationIdentity) {
    const service = this.repository.get('service', identity.serviceId), account = this.repository.get('account', identity.accountId);
    if (!service || !service.enabled || service.removed || service.revision !== identity.serviceRevision || service.configVersion !== identity.configVersion
      || !account || account.serviceId !== identity.serviceId || account.revision !== identity.accountRevision || account.state !== 'ready')
      throw new McpError('identity-changed', 'MCP 服务或账号的适用身份已变化。');
    const catalog = this.policy.catalog(identity);
    const tool = catalog.tools.find(item => item.toolId === identity.toolId);
    if (catalog.serviceId !== identity.serviceId || catalog.accountId !== identity.accountId || catalog.accountRevision !== identity.accountRevision
      || catalog.configVersion !== identity.configVersion || catalog.version !== identity.catalogVersion || !tool || tool.definitionVersion !== identity.definitionVersion)
      throw new McpError('catalog-changed', 'MCP 工具目录或 Schema 已变化。');
    return { catalog, tool };
  }
  private terminal(request: McpAuthorization, status: 'expired' | 'cancelled' | 'invalidated'): McpAuthorization {
    const next = { ...request, revision: request.revision + 1, status, decidedAt: this.at() };
    this.repository.commit(`mcp-terminal:${request.requestId}:${status}`, mcpFingerprint(next), this.at(), tx => tx.put('authorization', next, request.revision));
    this.notify(request.requestId); return next;
  }
  private at(): string { return new Date(this.now()).toISOString(); }
}
