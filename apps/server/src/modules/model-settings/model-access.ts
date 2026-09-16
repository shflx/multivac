import type {
  ModelAccessErrorCode, ModelAccessReceipt, ModelConnectionCheck, ModelProfileInput,
} from '@multivac/contracts';

export class ModelAccessError extends Error {
  constructor(readonly code: ModelAccessErrorCode) { super(code); this.name = 'ModelAccessError'; }
}
export interface ModelAccessBackend {
  credentialInfo(profile: ModelProfileInput, signal: AbortSignal): Promise<{ storedApiKey: boolean; configurable: boolean }>;
  configure(profile: ModelProfileInput, apiKey: string, signal: AbortSignal, version?: string): Promise<void>;
  revoke(profile: ModelProfileInput, signal: AbortSignal, version?: string): Promise<void>;
  check(profile: ModelProfileInput, signal: AbortSignal): Promise<void>;
  /** 非秘密的文件变更标识；不能读取凭据内容或计算密钥 hash。 */
  credentialVersion(): Promise<string>;
}
export interface StoredAccessCommand extends ModelAccessReceipt {
  provider: string;
  baselineAccessRevision: number;
}
export interface StoredConnectionCheck extends ModelConnectionCheck {
  provider: string;
  configRevision: number;
  credentialRevision: number;
}
export interface ModelAccessState {
  version: 1;
  accessRevision: number;
  credentialRevision: number;
  commands: StoredAccessCommand[];
  checks: StoredConnectionCheck[];
}
export interface ModelAccessStore {
  load(): Promise<ModelAccessState>;
  /** 在不可取消的提交点前同步调用；抛错必须保留旧文件。 */
  save(state: ModelAccessState, beforeCommit?: () => void): Promise<void>;
}
