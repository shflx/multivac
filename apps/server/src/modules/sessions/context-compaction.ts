import type { ContextCompactionOperation } from '@multivac/contracts';
import type { CoordinatorSessionRecoveryIdentity } from './coordinator-adapter.js';

export interface StoredContextCompaction {
  fingerprint: string;
  identity: CoordinatorSessionRecoveryIdentity | null;
  operation: ContextCompactionOperation;
}
export interface ContextCompactionRepository {
  get(sessionId: string, operationId: string): StoredContextCompaction | undefined;
  latest(sessionId: string): StoredContextCompaction | undefined;
  pending(sessionId: string): StoredContextCompaction | undefined;
  /** 意图提交后才允许请求原生压缩；数据库同时排斥同会话的另一个活动操作。 */
  insert(record: StoredContextCompaction): void;
  finish(record: StoredContextCompaction): void;
}
export function compactionPending(operation: ContextCompactionOperation): boolean {
  return operation.status === 'running' || operation.status === 'reconciliation-required' || operation.commitState === 'unknown';
}
