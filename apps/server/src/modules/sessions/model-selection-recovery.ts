import type { CoordinatorModelEndpointMode, CoordinatorModelSource } from '@multivac/contracts';

export function isPiNativeDynamicEndpoint(protocol: string | null | undefined): boolean {
  return protocol === 'azure-openai-responses';
}

export function safeModelProtocol(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(value);
}

export function safeModelEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function equalModelEndpoints(left: string, right: string): boolean {
  return new URL(left).toString().replace(/\/$/u, '') ===
    new URL(right).toString().replace(/\/$/u, '');
}

export interface ModelSelectionRecoveryRecord {
  version: 1;
  phase: 'initialization-intent';
  selectionKind: CoordinatorModelSource;
  assistantSessionId: string;
  piSessionId: string;
  piSessionPath: string;
  provider: string;
  modelId: string;
  profileId: string | null;
  protocol: string | null;
  endpoint: string | null;
  endpointMode?: CoordinatorModelEndpointMode;
  resolvedEndpoint: string | null;
  createdAt: string;
}

export interface ModelSelectionRecoveryRepository {
  get(piSessionId: string): Promise<ModelSelectionRecoveryRecord | undefined>;
  saveIfAbsent(record: ModelSelectionRecoveryRecord): Promise<ModelSelectionRecoveryRecord>;
}
