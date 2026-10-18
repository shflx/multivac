import { createHash } from 'node:crypto';
import { Check } from 'typebox/value';
import { McpFactSchemas } from '@multivac/contracts';
import type {
  McpAccount, McpAuthorization, McpCall, McpCatalog, McpClassification, McpConnection,
  McpErrorCode, McpImportPreview, McpJson, McpResourceSnapshot, McpRule, McpService, McpTransport,
} from '@multivac/contracts';

export class McpError extends Error {
  constructor(readonly code: McpErrorCode, message: string, readonly status = 409) {
    super(message);
    this.name = 'McpError';
  }
}

/** 仅 MCP 新账本使用此规范化编码，不修改既有模块的历史指纹规则。 */
export function mcpCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(mcpCanonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${mcpCanonical(object[key])}`).join(',')}}`;
  }
  throw new McpError('invalid-config', 'MCP 数据必须是有限的 JSON 值。', 400);
}
export function mcpFingerprint(value: unknown): string {
  return createHash('sha256').update(mcpCanonical(value)).digest('hex');
}
export function mcpToolId(serviceId: string, name: string): string {
  return `mcp_${mcpFingerprint([serviceId, name])}`;
}

export function validateMcpTransport(transport: McpTransport): void {
  if (transport.kind === 'stdio') {
    exactKeys(transport, ['kind', 'command', 'args', 'cwd', 'environmentKeys']);
    if (!transport.command.trim() || transport.command.length > 4096 || /[\r\n\0]/u.test(transport.command)) invalid();
    if (transport.cwd !== null && (!transport.cwd || transport.cwd.length > 4096 || /[\r\n\0]/u.test(transport.cwd))) invalid();
    if (transport.args.length > 128 || transport.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) invalid();
    if (transport.environmentKeys.length > 64 || new Set(transport.environmentKeys).size !== transport.environmentKeys.length
      || transport.environmentKeys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key))) invalid();
    // 参数是公开配置。私有值须通过账号存储注入；此处验证不授予命令执行权。
    return;
  }
  if (transport.kind !== 'streamable-http' && transport.kind !== 'legacy-sse') invalid();
  exactKeys(transport, ['kind', 'url']);
  let url: URL;
  try { url = new URL(transport.url); } catch { return invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || transport.url.length > 4096) invalid();
}
function invalid(): never {
  throw new McpError('invalid-config', 'MCP 配置无效；凭据须在独立账号中配置。', 400);
}
function exactKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) invalid();
}

export interface McpFacts {
  service: McpService;
  account: McpAccount;
  connection: McpConnection;
  catalog: McpCatalog;
  classification: McpClassification;
  rule: McpRule;
  authorization: McpAuthorization;
  call: McpCall;
  resourceSnapshot: McpResourceSnapshot;
  importPreview: McpImportPreview;
}
export type McpFactKind = keyof McpFacts;
export interface McpFactRef { kind: McpFactKind; id: string; revision: number }
export interface McpReceipt {
  commandId: string;
  changes: McpFactRef[];
  createdAt: string;
}
export interface McpReader {
  get<K extends McpFactKind>(kind: K, id: string): McpFacts[K] | null;
  list<K extends McpFactKind>(kind: K, options?: { serviceId?: string; offset?: number; limit?: number }): McpFacts[K][];
}
export interface McpTransaction extends McpReader {
  /** expectedRevision=0 表示新建；持久化 revision 必须恰好增加一。 */
  put<K extends McpFactKind>(kind: K, value: McpFacts[K], expectedRevision: number): void;
}
export interface McpRepository extends McpReader {
  receipt(commandId: string, fingerprint: string): McpReceipt | null;
  /** callback 只做同步事实写入，不在 SQLite 事务中执行文件、网络、模型或进程。 */
  commit(commandId: string, fingerprint: string, at: string, operation: (tx: McpTransaction) => void): McpReceipt;
  serviceVersion(serviceId: string, version: string): McpTransport | null;
}

export const mcpIdKeys = {
  service: 'serviceId', account: 'accountId', connection: 'connectionId', catalog: 'catalogId',
  classification: 'classificationId', rule: 'ruleId', authorization: 'requestId', call: 'callId',
  resourceSnapshot: 'snapshotId', importPreview: 'previewId',
} as const;
export function mcpFactId<K extends McpFactKind>(kind: K, value: McpFacts[K]): string {
  return (value as unknown as Record<string, string>)[mcpIdKeys[kind]]!;
}
export function mcpFactService(value: McpFacts[McpFactKind]): string | null {
  if ('identity' in value) return value.identity.serviceId;
  return 'serviceId' in value ? value.serviceId : null;
}

/** 仓储拒绝多余顶层字段，防止误把私有凭据对象扩展进公开 JSON。 */
export function validateMcpFact<K extends McpFactKind>(kind: K, value: McpFacts[K]): void {
  if (!Check(McpFactSchemas[kind], value)) invalid();
  const id = mcpFactId(kind, value);
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id)
    || !Number.isSafeInteger(value.revision) || value.revision < 1) invalid();
  const bytes = Buffer.byteLength(mcpCanonical(value));
  if (bytes > (kind === 'catalog' ? 2_000_000 : kind === 'resourceSnapshot' ? 1_000_000 : 64_000))
    throw new McpError('limit-exceeded', 'MCP 记录超过大小限制。', 413);
  if ('transport' in value) {
    validateMcpTransport(value.transport);
    if (value.configVersion !== mcpFingerprint(value.transport)) invalid();
  }
  if (kind === 'catalog') {
    const catalog = value as McpCatalog;
    if (catalog.version !== mcpFingerprint({ tools: catalog.tools, resources: catalog.resources, resourceTemplates: catalog.resourceTemplates })) invalid();
    for (const tool of catalog.tools) {
      const { toolId, definitionVersion, ...definition } = tool;
      if (toolId !== mcpToolId(catalog.serviceId, tool.name) || definitionVersion !== mcpFingerprint(definition)) invalid();
    }
    if (new Set(catalog.tools.map(tool => tool.name)).size !== catalog.tools.length
      || new Set(catalog.resources.map(resource => resource.uri)).size !== catalog.resources.length
      || new Set(catalog.resourceTemplates.map(template => template.uriTemplate)).size !== catalog.resourceTemplates.length) invalid();
  }
  if (kind === 'authorization') {
    const request = value as McpAuthorization;
    if (request.argumentsFingerprint !== mcpFingerprint(request.arguments)
      || (request.status === 'pending') !== (request.decidedAt === null)
      || request.revokedAt !== null && request.status !== 'allowed') invalid();
  }
  if (kind === 'classification' && !(value as McpClassification).effects.length) invalid();
  if (kind === 'account') {
    const account = value as McpAccount;
    if (account.auth === 'none' && account.credentialRef !== null) invalid();
    if (account.auth !== 'none' && account.state === 'ready' && account.credentialRef === null) invalid();
  }
} 

export function assertMcpTransition(kind: McpFactKind, before: McpFacts[McpFactKind], after: McpFacts[McpFactKind]): void {
  if (mcpFactService(before) !== mcpFactService(after)) conflict();
  if (kind === 'catalog' || kind === 'resourceSnapshot' || kind === 'importPreview') conflict();
  if (kind === 'service' && (before as McpService).removed) conflict();
  if (kind === 'connection') {
    const previous = before as McpConnection, next = after as McpConnection;
    if (previous.accountId !== next.accountId || previous.accountRevision !== next.accountRevision || previous.configVersion !== next.configVersion) conflict();
    const allowed: Record<McpConnection['state'], McpConnection['state'][]> = {
      connecting: ['connected', 'failed', 'closing'], connected: ['disconnected', 'failed', 'closing'],
      disconnected: ['closing', 'closed'], failed: ['closing', 'closed'], closing: ['closed', 'failed'], closed: [],
    };
    if (!allowed[previous.state].includes(next.state)) conflict();
  }
  if ('identity' in before && 'identity' in after
    && (mcpCanonical(before.identity) !== mcpCanonical(after.identity)
      || before.argumentsFingerprint !== after.argumentsFingerprint)) conflict();
  if (kind === 'call') {
    const previous = before as McpCall, next = after as McpCall;
    const allowed: Record<McpCall['state'], McpCall['state'][]> = {
      prepared: ['running', 'cancelled', 'failed'], running: ['succeeded', 'failed', 'cancel-requested', 'unknown'],
      'cancel-requested': ['cancelled', 'succeeded', 'failed', 'unknown'],
      unknown: ['succeeded', 'failed', 'cancelled'], succeeded: [], failed: [], cancelled: [],
    };
    if (!allowed[previous.state].includes(next.state) || previous.authorizationId !== next.authorizationId) conflict();
  }
  if (kind === 'authorization') {
    const previous = before as McpAuthorization, next = after as McpAuthorization;
    const deciding = previous.status === 'pending' && next.status !== 'pending' && next.revokedAt === null;
    const revoking = previous.status === 'allowed' && next.status === 'allowed' && previous.revokedAt === null && next.revokedAt !== null && previous.decidedAt === next.decidedAt;
    if ((!deciding && !revoking) || mcpCanonical(previous.effects) !== mcpCanonical(next.effects)
      || previous.expiresAt !== next.expiresAt || previous.createdAt !== next.createdAt
      || mcpCanonical(previous.operation) !== mcpCanonical(next.operation)) conflict();
  }
  if (kind === 'rule' && mcpCanonical(ruleIdentity((before as McpRule).target)) !== mcpCanonical(ruleIdentity((after as McpRule).target))) conflict();
  if (kind === 'classification') {
    const previous = before as McpClassification, next = after as McpClassification;
    if (previous.revokedAt || !next.revokedAt
      || mcpCanonical({ ...previous, revision: next.revision, revokedAt: next.revokedAt }) !== mcpCanonical(next)) conflict();
  }
}
export function ruleIdentity(target: McpRule['target']): McpJson {
  if (target.kind === 'project') return [target.kind, target.projectId];
  if (target.kind === 'agent') return [target.kind, target.agentId];
  return [target.kind, target.sessionId];
}
function conflict(): never { throw new McpError('conflict', 'MCP 身份、版本或状态迁移冲突。'); }
