import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantQuoteWithinLimit, type AssistantMcpQuote, type McpResourceRead, type McpResourceReadPreview, type McpResourceReadResult, type McpResourceReference, type McpResourceSelection, type McpResourceSnapshot } from '@multivac/contracts';
import { McpError, mcpCanonical, mcpFingerprint, type McpRepository } from '../modules/mcp/mcp.js';
import { McpRules } from '../modules/mcp/rules.js';
import type { McpConnections } from '../modules/mcp/connections.js';
import type { McpExecutionHost } from './mcp-execution-service.js';

const MAX_TEXT_BYTES = 32_000;
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json', 'application/xml', 'text/xml']);
/** 资源只由真实用户读取；模型不会自动获取目录正文或触发模板。 */
export class McpResourceService {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<McpResourceReadResult> }>();
  constructor(private readonly repository: McpRepository, private readonly connections: McpConnections, private readonly host: McpExecutionHost, private readonly now = () => new Date().toISOString()) {}
  list(sessionId: string, offset = 0, limit = 25) {
    const context = this.host.context(sessionId, null);
    if (context.host !== 'work') throw new McpError('rule-denied', '资源选择仅提供给普通工作会话。');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new McpError('invalid-config', '资源分页无效。', 400);
    const items = this.connections.active(sessionId).flatMap(connection => {
      try {
        const live = this.connections.get(connection.connectionId, sessionId), service = this.repository.get('service', connection.serviceId)!;
        const effective = new McpRules(this.repository).resolve(service.serviceId, { ...context, accountId: connection.accountId, transportAllowed: this.host.transport(service, context) }, service.transport.kind === 'streamable-http' ? ['read', 'data-transfer'] : ['read']);
        if (!effective.available) return [];
        return [...live.catalog.resources.map(resource => ({ kind: 'resource' as const, connectionId: connection.connectionId, catalogVersion: live.catalog.version, serviceId: service.serviceId, serviceName: service.name, accountId: connection.accountId, accountRevision: connection.accountRevision, resource })),
          ...live.catalog.resourceTemplates.map(resource => ({ kind: 'template' as const, connectionId: connection.connectionId, catalogVersion: live.catalog.version, serviceId: service.serviceId, serviceName: service.name, accountId: connection.accountId, accountRevision: connection.accountRevision, resource }))];
      } catch (error) { if (error instanceof McpError) return []; throw error; }
    });
    return { items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  preview(selection: McpResourceSelection): McpResourceReadPreview {
    const context = this.host.context(selection.sessionId, null), live = this.connections.get(selection.connectionId, selection.sessionId);
    if (context.host !== 'work') throw new McpError('rule-denied', '资源读取仅提供给普通工作会话。');
    const { connection, catalog } = live, service = this.repository.get('service', connection.serviceId)!, account = this.repository.get('account', connection.accountId)!;
    if (selection.catalogVersion !== catalog.version) throw new McpError('catalog-changed', '资源目录版本已变化，请重新选择。');
    const uri = resourceUri(selection, catalog.resources.map(value => value.uri), catalog.resourceTemplates.map(value => value.uriTemplate));
    assertResourceUri(uri, context.workingDirectory, service.transport.kind === 'stdio');
    const effective = new McpRules(this.repository).resolve(service.serviceId, { ...context, accountId: account.accountId, transportAllowed: this.host.transport(service, context) }, service.transport.kind === 'streamable-http' ? ['read', 'data-transfer'] : ['read']);
    if (!effective.available) throw new McpError('rule-denied', effective.details.join('；'));
    const evidence = { serviceId: service.serviceId, serviceRevision: service.revision, serviceName: service.name, source: service.source, transport: service.transport,
      configVersion: service.configVersion, accountId: account.accountId, accountLabel: account.label, accountRevision: account.revision,
      catalogVersion: catalog.version, selection, uri, context, ruleVersions: effective.ruleVersions };
    return { selection, uri, evidence, fingerprint: mcpFingerprint(evidence), impact: '向所示服务发送 resources/read，仅读取本次 URI；最多保留 32 KB UTF-8 文本。不执行 HTML，不读取嵌入链接，不自动交给模型。发送时将另行核对数据外传规则。' };
  }
  result(input: McpResourceRead): McpResourceReadResult {
    this.host.context(input.sessionId, null);
    const snapshot = this.repository.get('resourceSnapshot', mcpFingerprint(['resource', input.sessionId, input.commandId]));
    const receipt = this.repository.receipt(`mcp-resource-read:${input.commandId}`, mcpFingerprint(input));
    if (snapshot && snapshot.sessionId !== input.sessionId) throw new McpError('identity-changed', '资源快照不属于此会话。');
    return { status: snapshot ? 'succeeded' : receipt ? 'unknown' : 'not-started', snapshot };
  }
  read(input: McpResourceRead): Promise<McpResourceReadResult> {
    input = structuredClone(input);
    const key = input.commandId, fingerprint = mcpFingerprint(input), old = this.pending.get(key);
    if (old) { if (old.fingerprint !== fingerprint) return Promise.reject(new McpError('conflict', '同一资源读取参数不一致。')); return old.promise; }
    const promise = this.perform(input).finally(() => this.pending.delete(key)); this.pending.set(key, { fingerprint, promise }); return promise;
  }
  private async perform(input: McpResourceRead): Promise<McpResourceReadResult> {
    const previous = this.result(input); if (previous.status !== 'not-started') return previous;
    const selection: McpResourceSelection = { sessionId: input.sessionId, connectionId: input.connectionId, catalogVersion: input.catalogVersion, parameters: input.parameters,
      ...(input.uri === undefined ? {} : { uri: input.uri }), ...(input.template === undefined ? {} : { template: input.template }) };
    const assert = () => { const preview = this.preview(selection); if (preview.fingerprint !== input.fingerprint) throw new McpError('identity-changed', '资源读取范围已变化，请重新预览。'); return preview; };
    let preview = assert();
    await this.connections.refresh(input.connectionId, input.sessionId); preview = assert();
    const live = this.connections.get(input.connectionId, input.sessionId), account = this.repository.get('account', live.connection.accountId)!;
    const redact = await this.host.redactor(account.accountId, account.revision); assert();
    // 意图先持久化；崩溃或响应未知只能查询，不能重新读取可能有副作用的服务。
    this.repository.commit(`mcp-resource-read:${input.commandId}`, mcpFingerprint(input), this.now(), () => {});
    let leased = false;
    try {
      const value = await live.client.rpc('resources/read', { uri: preview.uri }, undefined, () => { assert(); this.host.lease(input.sessionId, 'starting', input.commandId, Buffer.byteLength(preview.uri)); leased = true; });
      assert();
      const content = resourceText(value, preview.uri, redact), text = content.text;
      const evidence = preview.evidence as { serviceId: string; serviceName: string; serviceRevision: number; configVersion: string; catalogVersion: string; accountLabel: string; ruleVersions: { ruleId: string; revision: number }[]; context: { projectId: string | null; workingDirectory: string } };
      const snapshot: McpResourceSnapshot = { snapshotId: mcpFingerprint(['resource', input.sessionId, input.commandId]), revision: 1, sessionId: input.sessionId,
        serviceId: evidence.serviceId, accountId: account.accountId, accountRevision: account.revision, configVersion: evidence.configVersion, catalogVersion: evidence.catalogVersion,
        uri: preview.uri, mimeType: content.mimeType, text, truncated: content.truncated, readAt: this.now(),
        provenance: { serviceName: evidence.serviceName, accountLabel: evidence.accountLabel, serviceRevision: evidence.serviceRevision, projectId: evidence.context.projectId, workingDirectory: evidence.context.workingDirectory, ruleVersions: evidence.ruleVersions } };
      this.repository.commit(`mcp-resource-snapshot:${input.commandId}`, mcpFingerprint(snapshot), this.now(), tx => tx.put('resourceSnapshot', snapshot, 0));
      return { status: 'succeeded', snapshot };
    } catch (error) { throw error instanceof McpError ? error : new McpError('result-unknown', '资源读取结果未知，请按原命令核对，不自动重试。'); }
    finally { if (leased) this.host.lease(input.sessionId, 'settled', input.commandId, 0); }
  }
  reference(snapshot: McpResourceSnapshot): McpResourceReference {
    if (!snapshot.provenance) throw new McpError('identity-changed', '旧资源缺少来源证据，需要重新读取。');
    return { snapshotId: snapshot.snapshotId, serviceId: snapshot.serviceId, serviceName: snapshot.provenance.serviceName, accountId: snapshot.accountId, accountLabel: snapshot.provenance.accountLabel,
      accountRevision: snapshot.accountRevision, configVersion: snapshot.configVersion, catalogVersion: snapshot.catalogVersion, uri: snapshot.uri, mimeType: snapshot.mimeType, readAt: snapshot.readAt, truncated: snapshot.truncated };
  }
  /** 发送是独立的数据外传决定；只接受本会话快照选区，不读取或替换为服务最新正文。 */
  quote(sessionId: string, quote: AssistantMcpQuote, commandId: string | null = null): AssistantMcpQuote {
    const snapshot = this.repository.get('resourceSnapshot', quote.sourceMcp.snapshotId), context = this.host.context(sessionId, commandId);
    if (!snapshot?.provenance || snapshot.sessionId !== sessionId || quote.sourceSessionId !== sessionId || context.host !== 'work') throw new McpError('rule-denied', '资源引用不能跨会话、转交全局或用于其他宿主。');
    if (!assistantQuoteWithinLimit(quote) || !quote.text.trim() || !snapshot.text.includes(quote.text) || mcpCanonical(this.reference(snapshot)) !== mcpCanonical(quote.sourceMcp)) throw new McpError('identity-changed', '资源引用文本或来源不匹配，请重新选择。');
    const service = this.repository.get('service', snapshot.serviceId), account = this.repository.get('account', snapshot.accountId), source = snapshot.provenance;
    if (!service || service.revision !== source.serviceRevision || service.configVersion !== snapshot.configVersion || !account || account.revision !== snapshot.accountRevision || account.state !== 'ready'
      || source.projectId !== context.projectId || source.workingDirectory !== context.workingDirectory) throw new McpError('identity-changed', '资源引用的服务、账号、项目或目录已变化，请重新读取。');
    assertResourceUri(snapshot.uri, context.workingDirectory, service.transport.kind === 'stdio');
    const effective = new McpRules(this.repository).resolve(service.serviceId, { ...context, accountId: snapshot.accountId, transportAllowed: this.host.transport(service, context) }, ['read', 'data-transfer']);
    if (!effective.available || mcpCanonical(effective.ruleVersions) !== mcpCanonical(source.ruleVersions)) throw new McpError('rule-denied', '当前规则不允许将此资源快照交给模型，请重新核对。');
    return { sourceKind: 'mcp', sourceMcp: this.reference(snapshot), sourceSessionId: sessionId, sourceTitle: source.serviceName, text: quote.text };
  }
}

export function resourceUri(selection: McpResourceSelection, resources: string[], templates: string[]): string {
  if (Boolean(selection.uri) === Boolean(selection.template)) throw new McpError('invalid-config', '请唯一选择资源或模板。', 400);
  if (selection.uri) { if (!resources.includes(selection.uri) || Object.keys(selection.parameters).length) throw new McpError('catalog-changed', '资源不在固定目录中，或不接受模板参数。'); return selection.uri; }
  const template = selection.template!;
  if (!templates.includes(template)) throw new McpError('catalog-changed', '模板不在固定目录中。');
  const variables = [...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/gu)].map(match => match[1]!);
  if (!variables.length || template.replace(/\{[A-Za-z_][A-Za-z0-9_]{0,63}\}/gu, '').match(/[{}]/u) || Object.keys(selection.parameters).some(key => !variables.includes(key)) || variables.some(key => !Object.hasOwn(selection.parameters, key)))
    throw new McpError('invalid-config', '仅支持 {name} 简单模板，必须提供全部且仅提供所需参数。', 400);
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/gu, (_all, key: string) => encodeURIComponent(selection.parameters[key]!));
}
export function assertResourceUri(uri: string, directory: string, local: boolean): void {
  let url: URL; try { url = new URL(uri); } catch { throw new McpError('invalid-config', '资源需要绝对 URI。', 400); }
  if (uri.length > 4096 || url.username || url.password || ['javascript:', 'data:'].includes(url.protocol)) throw new McpError('rule-denied', '资源 URI 不受支持。');
  if (url.protocol !== 'file:') return;
  try {
    if (!local || url.host || url.search || url.hash) throw Error();
    const path = realpathSync(fileURLToPath(url)), root = realpathSync(directory), suffix = relative(root, path);
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw Error();
  } catch { throw new McpError('rule-denied', '资源 URI 超出真实工作目录或目标无法核对。'); }
}
export function resourceText(value: unknown, uri: string, redact: (text: string) => string = text => text): { text: string; mimeType: string; truncated: boolean } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { contents?: unknown }).contents)) throw new McpError('unsupported-protocol', '资源响应缺少 contents。');
  const contents = (value as { contents: unknown[] }).contents;
  if (contents.length !== 1) throw new McpError('unsupported-protocol', '当前仅支持返回一个与所选 URI 相同的文本资源。');
  const item = contents[0] as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }, mimeType = typeof item?.mimeType === 'string' ? item.mimeType.split(';')[0]!.trim().toLowerCase() : 'text/plain';
  if (!item || item.uri !== uri || typeof item.text !== 'string' || item.blob !== undefined || !TEXT_TYPES.has(mimeType)) throw new McpError('unsupported-protocol', '资源 URI、二进制或内容类型不受支持；内容未保存或交给模型。');
  const bytes = Buffer.from(redact(item.text), 'utf8'), truncated = bytes.length > MAX_TEXT_BYTES;
  let end = Math.min(bytes.length, MAX_TEXT_BYTES); while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), mimeType, truncated };
}
