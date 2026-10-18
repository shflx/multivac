import type { McpAccount } from '@multivac/contracts';

/** 私有资料只经此端口流转，不得用于模型工具、公开事件、导出或 SQLite 命令指纹。 */
export interface McpPrivateCredentials {
  instanceId: string;
  serviceId: string;
  accountId: string;
  configVersion: string;
  accountRevision: number;
  state: 'pending' | 'exchanging' | 'ready' | 'refreshing' | 'revoked' | 'unknown';
  bearer: string | null;
  environment: Record<string, string>;
  oauth: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    clientId: string;
    scope: string;
    redirectUri: string;
    resource: string;
    state: string;
    verifier: string;
    expiresAt: number;
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiresAt: number | null;
  } | null;
}
export interface McpCredentialVault {
  readonly instanceId: string;
  read(ref: string): Promise<McpPrivateCredentials | null>;
  /** 私有存储原生锁内执行；undefined 表示不改写。 */
  modify(ref: string, operation: (current: McpPrivateCredentials | null) => Promise<McpPrivateCredentials | undefined>): Promise<void>;
}
export interface McpOAuthConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
}
export interface McpAccountView { account: McpAccount; loginUrl?: string }
export interface McpOAuthHttp {
  /** 对已确认的服务身份和每个认证地址分别核对网络许可。 */
  authorize(url: string, serviceId: string): Promise<void>;
  request: typeof fetch;
}
