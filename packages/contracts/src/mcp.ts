/** MCP 公开契约。凭据仅由私有存储解析，不保存值、摘要或 OAuth 授权码。 */
export type McpVersion = string;
export type McpEffect = 'read' | 'local-write' | 'external-write' | 'data-transfer';
export type McpHost = 'work' | 'task' | 'coordinator';
export type McpJson = null | boolean | number | string | McpJson[] | { [key: string]: McpJson };

export type McpTransport =
  | { kind: 'stdio'; command: string; args: string[]; cwd: string | null; environmentKeys: string[] }
  | { kind: 'streamable-http'; url: string }
  | { kind: 'legacy-sse'; url: string };

export interface McpService {
  serviceId: string;
  revision: number;
  name: string;
  source: string;
  transport: McpTransport;
  /** 配置内容版本与管理 revision 分开；启停不修改配置版本。 */
  configVersion: McpVersion;
  enabled: boolean;
  removed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpAccount {
  accountId: string;
  serviceId: string;
  revision: number;
  label: string;
  /** 私有存储中的不透明身份。不得用密钥或密钥摘要代替。 */
  credentialRef: string | null;
  auth: 'none' | 'bearer' | 'oauth';
  state: 'unconfigured' | 'ready' | 'login-required' | 'refresh-required' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

export interface McpConnection {
  connectionId: string;
  sessionId: string;
  serviceId: string;
  accountId: string;
  accountRevision: number;
  configVersion: McpVersion;
  revision: number;
  state: 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closing' | 'closed';
  protocolVersion: string | null;
  capabilities: { tools: boolean; resources: boolean; resourceTemplates: boolean };
  /** 固定错误码，不保存远程原始错误、命令环境或 HTTP 头。 */
  errorCode: McpErrorCode | null;
  updatedAt: string;
}

export interface McpTool {
  /** 由服务身份及原始工具名派生，不用显示名称匹配身份。 */
  toolId: string;
  name: string;
  description: string;
  inputSchema: { [key: string]: McpJson };
  outputSchema: { [key: string]: McpJson } | null;
  /** 完整工具定义版本，Schema、说明或声明变化均产生新版本。 */
  definitionVersion: McpVersion;
  /** 服务端声明，仅作资料。不得据此取得可信等级或执行许可。 */
  annotations: { [key: string]: McpJson };
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string | null;
}
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string | null;
}
export interface McpCatalog {
  catalogId: string;
  serviceId: string;
  accountId: string;
  accountRevision: number;
  configVersion: McpVersion;
  version: McpVersion;
  revision: number;
  tools: McpTool[];
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
  discoveredAt: string;
}

/** 分类必须由真实用户决定产生，并绑定当前配置、账号及目录。 */
export interface McpClassification {
  classificationId: string;
  revision: number;
  serviceId: string;
  accountId: string;
  accountRevision: number;
  configVersion: McpVersion;
  catalogVersion: McpVersion;
  toolId: string;
  definitionVersion: McpVersion;
  effects: McpEffect[];
  sourceDecisionId: string;
  confirmedAt: string;
  revokedAt: string | null;
}

export type McpRuleTarget =
  | { kind: 'project'; projectId: string; excluded: boolean; accountId: string | null }
  | { kind: 'agent'; agentId: string; preferred: boolean; effectCeiling: McpEffect[] }
  | { kind: 'session'; sessionId: string; disabled: boolean };
export interface McpRule {
  ruleId: string;
  serviceId: string;
  revision: number;
  target: McpRuleTarget;
  updatedAt: string;
}

/** 每次发送/调用固定身份；执行前仍须重新计算规则并核对版本。 */
export interface McpOperationIdentity {
  serviceId: string;
  serviceRevision: number;
  configVersion: McpVersion;
  accountId: string;
  accountRevision: number;
  catalogVersion: McpVersion;
  toolId: string;
  definitionVersion: McpVersion;
  sessionId: string;
  commandId: string;
  toolCallId: string;
  taskId: string | null;
  runId: string | null;
  agentId: string | null;
  host: McpHost;
  ruleVersions: { ruleId: string; revision: number }[];
}

export interface McpAuthorization {
  requestId: string;
  operation: { serviceName: string; source: string; transport: McpTransport; accountLabel: string; toolName: string };
  revision: number;
  identity: McpOperationIdentity;
  /** 固定参数摘要用于核对；不包含凭据存储内容或其摘要。 */
  argumentsFingerprint: string;
  arguments: { [key: string]: McpJson };
  effects: McpEffect[];
  status: 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled' | 'invalidated';
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  revokedAt: string | null;
}

export interface McpCall {
  callId: string;
  revision: number;
  identity: McpOperationIdentity;
  argumentsFingerprint: string;
  authorizationId: string | null;
  /** 许可与实际执行分别记录，取消请求不证明远端停止。 */
  state: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancel-requested' | 'cancelled' | 'unknown';
  errorCode: McpErrorCode | null;
  startedAt: string | null;
  finishedAt: string | null;
  resultRef: string | null;
}

export interface McpResourceSnapshot {
  snapshotId: string;
  revision: number;
  sessionId: string;
  serviceId: string;
  accountId: string;
  accountRevision: number;
  configVersion: McpVersion;
  catalogVersion: McpVersion;
  uri: string;
  mimeType: string;
  /** 不可变、已获准读取的内容快照；加入模型上下文仍需另行核对。 */
  text: string;
  truncated: boolean;
  readAt: string;
}

export interface McpImportPreview {
  previewId: string;
  revision: number;
  name: string;
  source: string;
  transport: McpTransport;
  existingServiceId: string | null;
  expectedServiceRevision: number | null;
  configVersion: McpVersion;
  createdAt: string;
  expiresAt: string;
}

export type McpErrorCode =
  | 'not-found' | 'conflict' | 'invalid-config' | 'unsupported-transport' | 'unsupported-protocol'
  | 'credential-unavailable' | 'identity-changed' | 'catalog-changed' | 'rule-denied'
  | 'classification-required' | 'authorization-required' | 'authorization-invalid'
  | 'connection-failed' | 'timeout' | 'cancelled' | 'result-unknown' | 'limit-exceeded';

export interface McpAvailability {
  serviceId: string;
  accountId: string | null;
  available: boolean;
  reasons: McpErrorCode[];
  ruleVersions: { ruleId: string; revision: number }[];
  /** 偏好只影响排序，不能改变 available 或效果上限。 */
  preferred: boolean;
}
