import type { McpAccount, McpAvailability, McpCall, McpCatalog, McpClassification, McpConnection, McpHost, McpRule, McpService, McpTransport } from './mcp.js';

export interface McpManagementList { services: McpService[]; total: number; nextOffset: number | null }
export interface McpManagementDetail {
  service: McpService;
  accounts: McpAccount[];
  catalogs: { catalog: McpCatalog; current: boolean }[];
  connections: { connection: McpConnection; usable: boolean }[];
  rules: McpRule[];
  classifications: McpClassification[];
  /** 列表不返回调用正文；查看结果需要用户显式打开单条调用。 */
  calls: McpCall[];
}
export interface McpConnectionPreview {
  serviceId: string; serviceRevision: number; source: string; configVersion: string; transport: McpTransport;
  accountId: string; accountRevision: number; accountLabel: string; sessionId: string; projectId: string | null;
  workingDirectory: string; host: McpHost; runId: string | null; ruleVersions: { ruleId: string; revision: number }[];
  fingerprint: string; available: boolean; reasons: string[];
}
export interface McpConnectionResult { connection: McpConnection | null; catalog: McpCatalog | null }
export interface McpAccountStatus { account: McpAccount; phase: string; expiresAt: number | null }
export interface McpScopeEntry { service: McpService; accounts: McpAccount[]; rule: McpRule | null; availability: McpAvailability | null; reason: string | null; editable: boolean }
