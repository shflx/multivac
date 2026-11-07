import type { CoordinatorRuntimeConfig, SubagentRun, WorkingDirectory } from '@multivac/contracts';
import type { AssistantAgentExecution } from '../sessions/assistant-turn.js';

export interface SubagentRecord {
  run: SubagentRun;
  context: string;
  fingerprint: string;
  workingDirectory: WorkingDirectory;
  execution: AssistantAgentExecution | null;
  runtimeConfig: CoordinatorRuntimeConfig | null;
  /** 真实工具租约按调用身份去重，跨重启只用于对账。 */
  markers: Record<string, boolean>;
}
export interface SubagentRepository {
  transaction<T>(operation: () => T): T;
  get(id: string): SubagentRecord | null;
  bySession(sessionId: string): SubagentRecord | null;
  byCall(parentSessionId: string, toolCallId: string): SubagentRecord | null;
  page(parentSessionId: string, offset: number, limit: number): { items: SubagentRecord[]; total: number };
  unsettled(parentSessionId?: string): SubagentRecord[];
  listPage(query: { parentSessionId?: string; taskId?: string; activeOnly?: boolean; offset: number; limit: number }): { items: SubagentRecord[]; total: number };
  save(record: SubagentRecord): void;
}

/** 未证明停止的运行持续占用并发与写入范围，终态标签本身不释放资源。 */
export function subagentOccupies(record: SubagentRecord): boolean { return !record.run.stopConfirmed; }
