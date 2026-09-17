import type { CoordinatorModelConfig, SessionModelCommandResult } from '@multivac/contracts';
import { equalModelEndpoints } from './model-selection-recovery.js';

function sameEndpoint(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left == null || right == null) return (left ?? null) === (right ?? null);
  try { return equalModelEndpoints(left, right); } catch { return false; }
}

/** 比较公开配置快照；URL 等价形式不能被误判为新端点。 */
export function sameSessionModelConfig(left: CoordinatorModelConfig, right: CoordinatorModelConfig): boolean {
  return left.provider === right.provider && left.modelId === right.modelId &&
    (left.source ?? 'base') === (right.source ?? 'base') && left.profileId === right.profileId &&
    left.protocol === right.protocol && sameEndpoint(left.endpoint, right.endpoint) &&
    sameEndpoint(left.resolvedEndpoint, right.resolvedEndpoint) &&
    (left.endpointMode ?? 'fixed') === (right.endpointMode ?? 'fixed');
}

export interface StoredSessionSelection {
  sessionId: string;
  piSessionId: string;
  piSessionPath: string;
  revision: number;
  model: CoordinatorModelConfig;
  pending: null | { commandId: string; previous: CoordinatorModelConfig; target: CoordinatorModelConfig };
  recoveryError: string | null;
}
export interface StoredSelectionCommand {
  commandId: string;
  fingerprint: string;
  result: SessionModelCommandResult | null;
}
export interface SessionSelectionRepository {
  getSelection(sessionId: string): StoredSessionSelection | undefined;
  saveSelection(selection: StoredSessionSelection): void;
  getSelectionCommand(commandId: string): StoredSelectionCommand | undefined;
  /** 意图与命令消费同一事务；Pi setter 只能发生在该提交之后。 */
  beginSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void;
  finishSelection(selection: StoredSessionSelection, command: StoredSelectionCommand): void;
}
